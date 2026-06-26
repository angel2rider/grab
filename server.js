import express from "express";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { statSync, mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { rename, stat } from "node:fs/promises";

import { detect, isValidUrl, PLATFORM_META } from "./lib/detect.js";
import {
  getInfo,
  listEntries,
  downloadOne,
  streamFile,
  cleanup,
  sanitizeFilename,
} from "./lib/ytdlp.js";
import { downloadZip } from "./lib/archive.js";
import { tagMp3 } from "./lib/tagging.js";
import { resolveMatch } from "./lib/matchers/index.js";
import { cacheGet, cacheSet, cacheStats } from "./lib/cache.js";
import sharp from "sharp";
import { rateLimit } from "express-rate-limit";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---- Rate Limiting ----
// Prevent abuse: 30 requests per minute per IP for API endpoints
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment." },
  keyGenerator: (req) => req.ip || req.headers["x-forwarded-for"] || "unknown",
});

// Stricter limit for download endpoint: 5 per minute
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Download rate limit reached. Please wait a moment." },
  keyGenerator: (req) => req.ip || req.headers["x-forwarded-for"] || "unknown",
});

// ---- CORS for split-architecture (CF Pages → VPS backend) ----
// Exact-match origins (production + local dev).
const ALLOWED_ORIGINS = [
  "https://grab.msedge.lol",
  "https://grab-front.pages.dev",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
// Wildcard patterns: any subdomain under these suffixes is allowed.
// This covers CF Pages preview deployments like e135f010.grab-front.pages.dev.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(.+\.)?grab-front\.pages\.dev$/,
];

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  for (const p of ALLOWED_ORIGIN_PATTERNS) {
    if (p.test(origin)) return true;
  }
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Always advertise Vary: Origin so edge caches don't serve one origin's
  // CORS response to a different origin (CDN caching correctness).
  res.setHeader("Vary", "Origin");
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Still serve static files for local development
app.use(express.static(join(__dirname, "public"), { maxAge: 0 }));

// ---- persistent downloads directory ----
const DOWNLOADS_DIR = join(__dirname, "downloads");
if (!existsSync(DOWNLOADS_DIR)) {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ---- ffmpeg dir resolution ----
function resolveFfmpegDir() {
  const fromEnv = process.env.FFMPEG_LOCATION || process.env.FFMPEG;
  let fromPath = null;
  try {
    fromPath = execSync("which ffmpeg", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {}
  for (const c of [fromEnv, fromPath, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter(Boolean)) {
    try {
      statSync(c);
      return dirname(c);
    } catch {}
  }
  return "/opt/homebrew/bin";
}
const FFMPEG_DIR = resolveFfmpegDir();

// ---- session store (prepare tokens) ----
const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000;

// ---- progress store for SSE streaming ----
// Maps token → { clients: Set<res>, status, percent, speed, eta, step, result?, error? }
const progressStore = new Map();

/**
 * Calculate dynamic file lifetime based on file size.
 * Formula: max(5 min, fileSize_bytes / ESTIMATED_SPEED_BYTES_PER_SEC)
 * Min 5 minutes, max 24 hours.
 */
const ESTIMATED_SPEED_BPS = 25 * 1024 * 1024 / 8; // 25 Mbps in bytes/sec
const MIN_ALIVE_MS = 5 * 60 * 1000;      // 5 minutes
const MAX_ALIVE_MS = 24 * 60 * 60 * 1000; // 24 hours

function calcAliveTime(fileSizeBytes) {
  if (!fileSizeBytes || fileSizeBytes <= 0) return MIN_ALIVE_MS;
  const transferTimeMs = (fileSizeBytes / ESTIMATED_SPEED_BPS) * 1000;
  const alive = Math.max(MIN_ALIVE_MS, Math.min(MAX_ALIVE_MS, transferTimeMs * 3));
  return alive;
}

/**
 * Broadcast a progress event to all SSE clients for a given token.
 */
function broadcastProgress(token, data) {
  const entry = progressStore.get(token);
  if (!entry) return;
  // Update stored state (merge so we don't lose fields like fileId / filename)
  Object.assign(entry, data);
  const msg = `event: progress\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of entry.clients) {
    try { client.write(msg); } catch {}
  }
  // If terminal state, close all clients and clean up
  if (data.status === "complete" || data.status === "error") {
    for (const client of entry.clients) {
      try { client.end(); } catch {}
    }
    entry.clients.clear();
    // Keep the completed entry around for 5 minutes so late SSE
    // connections can still get the result (poll-based fallback).
    setTimeout(() => progressStore.delete(token), 5 * 60_000);
  }
}

/**
 * Translate preset format IDs into yt-dlp format strings or quality hints.
 */
function resolveFormatPreset(formatId, mode) {
  if (!formatId) return null;
  if (/^(\d+(\+\d+)?)$/.test(formatId)) {
    if (mode === "audio" && ["320", "256", "192", "128"].includes(formatId)) return formatId;
    return formatId;
  }
  const heightMatch = formatId.match(/^(\d{3,4})p$/);
  if (heightMatch && mode === "video") {
    return `bestvideo[height<=${heightMatch[1]}]+bestaudio/best`;
  }
  return formatId;
}

function newToken() {
  return randomBytes(9).toString("base64url");
}

// ---- URL normalization ----
// Canonicalize URLs before caching so that different share formats,
// tracking params, and timestamps all resolve to the same cache key.
//
// YouTube variants handled:
//   youtu.be/ID?si=...    → https://www.youtube.com/watch?v=ID
//   youtube.com/watch?v=ID&list=...&t=42&si=... → https://www.youtube.com/watch?v=ID
//   m.youtube.com / music.youtube.com / youtube-nocookie.com
//   youtube.com/embed/ID / youtube.com/v/ID / youtube.com/shorts/ID
//
// Non-YouTube URLs: stripping common tracking params and fragments.

function normalizeUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) return url;

  // ---- YouTube: extract canonical video-ID URL ----
  const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  let videoId = null;

  // youtu.be/ID, you.tube/ID, youtu.be/ID?anything
  const ytBe = url.match(/^https?:\/\/(?:youtu\.be|you\.tube)\/([A-Za-z0-9_-]{11})/);
  if (ytBe) videoId = ytBe[1];

  // youtube.com/watch?v=ID, youtube.com/v/ID, youtube.com/shorts/ID, youtube.com/embed/ID
  if (!videoId) {
    const ytWatch = url.match(/^https?:\/\/(?:www\.|m\.|music\.|gaming\.|(?:[-\w]+\.))*youtube(?:-nocookie)?\.com\/(?:watch\?v=|v\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
    if (ytWatch) videoId = ytWatch[1];
  }

  // youtu.be URLs with /embed or /shorts paths
  if (!videoId) {
    const ytPath = url.match(/^https?:\/\/(?:www\.|m\.|music\.)*youtube\.com\/(?:embed|shorts|v|live)\/([A-Za-z0-9_-]{11})/);
    if (ytPath) videoId = ytPath[1];
  }

  if (videoId) {
    // Rebuild clean canonical YouTube URL: the gold-standard cache key.
    // Note: we keep the www. prefix so yt-dlp uses the standard extractor.
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  // ---- Non-YouTube: strip tracking params, timestamps, and fragments ----
  try {
    const parsed = new URL(url);
    // Strip known tracking / share / analytics params (safe to drop).
    const TRACKING_PARAMS = new Set([
      "si", "feature", "ref", "source", "utm_source", "utm_medium",
      "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid",
      "mc_cid", "mc_eid", "_ga", "_gl", "ref_", "spm", "scm",
      "wickedid", "yclid", "igshid", "twclid", "list",
    ]);
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (TRACKING_PARAMS.has(lower) || lower.startsWith("utm_") || lower.startsWith("ref_")) {
        parsed.searchParams.delete(key);
      }
    }
    // Strip timestamp if standalone (not for services that need it).
    // YouTube already handled above, but for other video hosts, keep the
    // URL clean. We only strip "t" if it's clearly a timestamp (numeric seconds).
    if (parsed.searchParams.has("t")) {
      const tVal = parsed.searchParams.get("t");
      if (/^\d+$/.test(tVal)) parsed.searchParams.delete("t");
    }
    if (parsed.searchParams.has("start")) {
      const sVal = parsed.searchParams.get("start");
      if (/^\d+$/.test(sVal)) parsed.searchParams.delete("start");
    }
    // Strip fragment
    parsed.hash = "";
    // Normalize host to lowercase
    parsed.hostname = parsed.hostname.toLowerCase();
    // Remove default ports
    if ((parsed.protocol === "https:" && parsed.port === "443") ||
        (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    url = parsed.toString();
  } catch {
    // Not a valid URL — return as-is.
  }

  return url;
}

// ---- thumbnail color extraction ----

/**
 * Extract a color palette from a thumbnail image.
 * Returns { accent, bg, surface } hex strings, or null on failure.
 *
 * accent  — most vibrant/saturated color (buttons, links, active states)
 * bg      — darkest non-black color with some saturation (page background tint)
 * surface — most common mid-brightness color (glass card tint)
 */
async function extractPalette(imageUrl) {
  if (!imageUrl) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(buffer)
      .resize(50, 50, { fit: "cover" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    const allPixels = [];
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const brightness = (r + g + b) / 3;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      allPixels.push({ r, g, b, brightness, saturation });
    }

    if (!allPixels.length) return null;

    const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
    const toHex = (r, g, b) => `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;

    // ── accent: most vibrant color (favors saturation × population) ──
    const quantize = (v) => Math.round(v / 32) * 32;
    const satMap = new Map();
    for (const p of allPixels) {
      if (p.brightness < 25 || p.brightness > 230) continue;
      const key = `${quantize(p.r)},${quantize(p.g)},${quantize(p.b)}`;
      satMap.set(key, (satMap.get(key) || 0) + p.saturation);
    }
    let accentHex = null;
    if (satMap.size > 0) {
      let best = null, bestScore = -1;
      for (const [k, s] of satMap) { if (s > bestScore) { bestScore = s; best = k; } }
      const [ar, ag, ab] = best.split(",").map(Number);
      accentHex = toHex(ar, ag, ab);
    }

    // ── bg: darkest color that still has some character (not pure black) ──
    // Sort by saturation, pick the dark pixel with most color.
    const darkPixels = allPixels.filter(p => p.brightness >= 8 && p.brightness <= 80 && p.saturation >= 10);
    darkPixels.sort((a, b) => b.saturation - a.saturation);
    let bgHex = null;
    if (darkPixels.length > 0) {
      const bg = darkPixels[0];
      // Darken and desaturate slightly for a background tone
      const mix = (v, k) => clamp(v * 0.55 + k * 0.45);
      bgHex = toHex(mix(bg.r, 10), mix(bg.g, 10), mix(bg.b, 10));
    }

    // ── surface: most common mid-brightness color (for glass card tint) ──
    const midPixels = allPixels.filter(p => p.brightness >= 30 && p.brightness <= 180 && p.saturation >= 15);
    const midMap = new Map();
    for (const p of midPixels) {
      const key = `${quantize(p.r)},${quantize(p.g)},${quantize(p.b)}`;
      midMap.set(key, (midMap.get(key) || 0) + 1);
    }
    let surfaceHex = null;
    if (midMap.size > 0) {
      let best = null, bestCount = -1;
      for (const [k, c] of midMap) { if (c > bestCount) { bestCount = c; best = k; } }
      const [sr, sg, sb] = best.split(",").map(Number);
      surfaceHex = toHex(sr, sg, sb);
    }

    if (!accentHex) return null;
    return { accent: accentHex, bg: bgHex, surface: surfaceHex };
  } catch (e) {
    console.error("  ▸ palette extraction failed:", e.message || e);
    return null;
  }
}

// ---- helpers for file storage ----
function writeMeta(id, meta) {
  const metaPath = join(DOWNLOADS_DIR, `${id}.meta.json`);
  writeFileSync(metaPath, JSON.stringify(meta));
}

function readMeta(id) {
  const metaPath = join(DOWNLOADS_DIR, `${id}.meta.json`);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function deleteStoredFile(id, ext) {
  try {
    const filePath = join(DOWNLOADS_DIR, `${id}.${ext}`);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {}
  try {
    const metaPath = join(DOWNLOADS_DIR, `${id}.meta.json`);
    if (existsSync(metaPath)) unlinkSync(metaPath);
  } catch {}
}

// ---- cleanup job: remove expired stored files every 60s ----
function runCleanupJob() {
  try {
    const files = readdirSync(DOWNLOADS_DIR);
    const now = Date.now();
    let cleaned = 0;
    for (const file of files) {
      if (!file.endsWith(".meta.json")) continue;
      const id = file.replace(".meta.json", "");
      const meta = readMeta(id);
      if (!meta || !meta.expiresAt || now > meta.expiresAt) {
        // Find the actual file extension
        const dataFile = files.find(f => f.startsWith(id + ".") && f !== file);
        if (dataFile) {
          try { unlinkSync(join(DOWNLOADS_DIR, dataFile)); } catch {}
        }
        try { unlinkSync(join(DOWNLOADS_DIR, file)); } catch {}
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`  ▸ cleanup: removed ${cleaned} expired file(s)`);
    }
  } catch (e) {
    console.error("cleanup job error:", e.message);
  }
}

// ---- GET /api/info ----
app.get("/api/info", apiLimiter, async (req, res) => {
  const url = normalizeUrl(req.query.url);
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Please paste a valid video or music link." });
  }

  // --- check cache first ---
  const cached = cacheGet(url);
  if (cached) {
    console.log(`  ▸ cache hit:  ${url.slice(0, 60)}…`);
    // Self-heal: if cached entry is missing palette, extract and update cache
    if (!cached.palette) {
      const thumbUrl = cached.thumbnail || cached.tracks?.[0]?.artwork;
      if (thumbUrl) {
        const palette = await extractPalette(thumbUrl);
        if (palette) {
          cached.palette = palette;
          cached.accentHex = palette.accent;
          cacheSet(url, cached, { platform: cached.platform || "", kind: cached.kind || "single" });
        }
      }
    }
    return res.json(cached);
  }

  const { type, platform } = detect(url);
  const platformMeta = PLATFORM_META[platform] || PLATFORM_META.generic;

  try {
    if (type === "match") {
      const result = await resolveMatch(platform, url);
      const resp = { sourceType: "match", platform, platformMeta, ...result };

      // Extract color palette from matched track artwork
      const artworkUrl = result.tracks?.[0]?.artwork || result.thumbnail;
      if (artworkUrl) {
        const palette = await extractPalette(artworkUrl);
        if (palette) {
          resp.palette = palette;
          resp.accentHex = palette.accent;
        }
      }

      cacheSet(url, resp, { platform, kind: result.kind || "single" });
      return res.json(resp);
    }

    const info = await listEntries(url);
    const resp = {
      sourceType: "direct",
      platform,
      platformMeta,
      ...info,
    };
    resp.platform = platform;

    // Extract color palette from YouTube thumbnail
    if (info.thumbnail) {
      const palette = await extractPalette(info.thumbnail);
      if (palette) {
        resp.palette = palette;
        resp.accentHex = palette.accent;
      }
    }

    cacheSet(url, resp, { platform, kind: info.kind || "single" });
    return res.json(resp);
  } catch (e) {
    return res.status(422).json({ error: e.message || "Couldn't resolve this link." });
  }
});

// ---- POST /api/prepare : stash a download job, return a token ----
app.post("/api/prepare", apiLimiter, (req, res) => {
  const body = req.body || {};
  if (body.url) body.url = normalizeUrl(body.url);
  // Also normalize URLs inside batch items
  if (Array.isArray(body.items)) {
    for (const it of body.items) {
      if (it.url) it.url = normalizeUrl(it.url);
      if (it.resolvedUrl) it.resolvedUrl = normalizeUrl(it.resolvedUrl);
    }
  }
  const { url, items, mode, formatId, isBatch, sourceType, platform } = body;

  if (sourceType === "match" && Array.isArray(items) && items.length) {
    const jobItems = items
      .filter((it) => it.resolvedUrl)
      .map((it) => ({
        url: it.resolvedUrl,
        mode: "audio",
        title: `${Array.isArray(it.artist) ? it.artist.join(", ") : it.artist || ""}${
          Array.isArray(it.artist) || it.artist ? " - " : ""
        }${it.title}`.trim(),
        meta: {
          title: it.title,
          artist: it.artist,
          album: it.album,
          trackNo: it.trackNo,
          image: it.artwork,
        },
      }));
    const token = newToken();
    sessions.set(token, { kind: "zip", items: jobItems, zipName: body.name || "tracks", createdAt: Date.now() });
    return res.json({ token, expiresIn: SESSION_TTL, downloadType: "zip" });
  }

  if (sourceType === "direct" && isBatch && Array.isArray(items) && items.length > 1) {
    const resolvedFormat = resolveFormatPreset(formatId, mode);
    const jobItems = items.map((it) => ({
      url: it.url,
      mode: mode || (it.isAudioOnly ? "audio" : "video"),
      formatId: resolvedFormat,
      title: it.title,
    }));
    const token = newToken();
    sessions.set(token, { kind: "zip", items: jobItems, zipName: body.name || "playlist", createdAt: Date.now() });
    return res.json({ token, expiresIn: SESSION_TTL, downloadType: "zip" });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL." });
  }
  const resolvedFormat = resolveFormatPreset(formatId, mode);
  const token = newToken();
  sessions.set(token, {
    kind: "single",
    url,
    mode,
    formatId: resolvedFormat,
    title: body.title,
    sourceType,
    meta: body.meta || null,
    createdAt: Date.now(),
  });
  res.json({ token, expiresIn: SESSION_TTL, downloadType: "file" });
});

// ---- POST /api/download : trigger background download, return immediately ----
app.post("/api/download", downloadLimiter, async (req, res) => {
  const { token } = req.body || {};
  const entry = sessions.get(token);
  if (!entry || Date.now() - entry.createdAt > SESSION_TTL) {
    return res.status(410).json({ error: "Download link expired. Please re-fetch." });
  }
  sessions.delete(token);

  // Init progress store for this token
  if (!progressStore.has(token)) {
    progressStore.set(token, { clients: new Set(), status: "starting", percent: 0, step: "Initializing…", speed: "", eta: "" });
  }

  res.json({ started: true });

  // Run download in background, broadcasting progress via SSE
  runBackgroundDownload(token, entry).catch((err) => {
    console.error("background download error:", err.message);
    broadcastProgress(token, { status: "error", error: err.message, percent: 0, step: "Failed" });
  });
});

/**
 * Background download worker. Updates progressStore and broadcasts via SSE.
 */
async function runBackgroundDownload(token, entry) {
  const fileId = token;
  broadcastProgress(token, { status: "starting", percent: 0, step: "Preparing download…", speed: "", eta: "" });

  if (entry.kind === "zip") {
    // ZIP batch download
    const items = entry.items;
    broadcastProgress(token, { status: "starting", percent: 0, step: `Resolving ${items.length} items…`, speed: "", eta: "" });

    try {
      const { filePath, ext } = await downloadZip({
        items,
        ffmpegDir: FFMPEG_DIR,
        outDir: DOWNLOADS_DIR,
        basename: fileId,
        zipName: entry.zipName,
        onItemProgress: (idx, total, title) => {
          const pct = Math.round((idx / total) * 100);
          broadcastProgress(token, {
            status: "downloading",
            percent: pct,
            step: `Downloading ${idx + 1} of ${total}…`,
            speed: "", eta: "",
            detail: title || "",
          });
        },
      });

      const fileSize = (await stat(filePath)).size;
      const aliveTime = calcAliveTime(fileSize);
      const expiresAt = Date.now() + aliveTime;
      const filename = `${sanitizeFilename(entry.zipName || "download")}.${ext}`;

      writeMeta(fileId, {
        filename, ext, size: fileSize, expiresAt,
        createdAt: Date.now(), aliveMinutes: Math.round(aliveTime / 60000),
      });

      broadcastProgress(token, {
        status: "complete",
        percent: 100, step: "Archive ready",
        fileId, downloadUrl: `/api/file/${fileId}`, filename, size: fileSize, aliveMinutes: Math.round(aliveTime / 60000),
      });
    } catch (e) {
      broadcastProgress(token, { status: "error", error: e.message, step: "Archive failed" });
    }
    return;
  }

  // Single item download with progress callback
  const onProgress = (prog) => {
    broadcastProgress(token, {
      status: prog.status || "downloading",
      percent: prog.percent,
      step: prog.step,
      speed: prog.speed || "",
      eta: prog.eta || "",
    });
  };

  try {
    const { filePath, dir, ext } = await downloadOne({
      url: entry.url,
      mode: entry.mode,
      formatId: entry.formatId,
      title: entry.title,
      ffmpegDir: FFMPEG_DIR,
      onProgress,
    });

    // Tag matched audio
    if (ext === "mp3" && entry.meta) {
      broadcastProgress(token, { status: "downloading", percent: 97, step: "Writing metadata tags…", speed: "", eta: "" });
      try {
        await tagMp3(filePath, entry.meta);
      } catch (e) {
        console.error("tag failed (non-fatal):", e.message);
      }
    }

    // Move file to persistent storage
    broadcastProgress(token, { status: "downloading", percent: 98, step: "Saving file…", speed: "", eta: "" });
    const storedPath = join(DOWNLOADS_DIR, `${fileId}.${ext}`);
    await rename(filePath, storedPath);
    await cleanup(dir);

    const fileSize = (await stat(storedPath)).size;
    const aliveTime = calcAliveTime(fileSize);
    const expiresAt = Date.now() + aliveTime;
    const filename = `${sanitizeFilename(entry.title || "media")}.${ext}`;

    writeMeta(fileId, {
      filename, ext, size: fileSize, expiresAt,
      createdAt: Date.now(), aliveMinutes: Math.round(aliveTime / 60000),
    });

    broadcastProgress(token, {
      status: "complete",
      percent: 100, step: "Download complete",
      fileId, downloadUrl: `/api/file/${fileId}`, filename, size: fileSize, aliveMinutes: Math.round(aliveTime / 60000),
    });
  } catch (e) {
    broadcastProgress(token, { status: "error", error: e.message, step: "Download failed" });
  }
}

// ---- GET /api/progress/:token : SSE endpoint for download progress ----
app.get("/api/progress/:token", (req, res) => {
  const token = req.params.token;

  // Init progress entry if not exists (for early connections before download starts)
  if (!progressStore.has(token)) {
    progressStore.set(token, { clients: new Set(), status: "waiting", percent: 0, step: "Waiting for download…", speed: "", eta: "" });
  }

  const entry = progressStore.get(token);

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send current state immediately (named event so client can distinguish)
  const currentState = {
    status: entry.status,
    percent: entry.percent,
    step: entry.step,
    speed: entry.speed || "",
    eta: entry.eta || "",
    detail: entry.detail || "",
  };
  res.write(`event: progress\ndata: ${JSON.stringify(currentState)}\n\n`);

  // If already in terminal state, close with result data
  if (entry.status === "complete") {
    res.write(`event: done\ndata: ${JSON.stringify({
      status: "complete", percent: 100, step: "Download complete",
      fileId: entry.fileId, downloadUrl: entry.downloadUrl,
      filename: entry.filename, size: entry.size, aliveMinutes: entry.aliveMinutes,
    })}\n\n`);
    return res.end();
  }
  if (entry.status === "error") {
    res.write(`event: done\ndata: ${JSON.stringify({ status: "error", error: entry.error || "Download failed.", step: "Download failed" })}\n\n`);
    return res.end();
  }

  // Heartbeat to keep connection alive
  const hb = setInterval(() => {
    try { res.write(`:\n\n`); } catch { clearInterval(hb); }
  }, 15_000);

  // Register client for live updates
  entry.clients.add(res);

  // Double-check: still not terminal after registering (race condition guard)
  if (entry.status === "complete" || entry.status === "error") {
    const terminalData = entry.status === "complete"
      ? { status: "complete", percent: 100, step: "Download complete",
          fileId: entry.fileId, downloadUrl: entry.downloadUrl,
          filename: entry.filename, size: entry.size, aliveMinutes: entry.aliveMinutes }
      : { status: "error", error: entry.error || "Download failed.", step: "Download failed" };
    try {
      res.write(`event: done\ndata: ${JSON.stringify(terminalData)}\n\n`);
    } catch {}
    try { res.end(); } catch {}
    clearInterval(hb);
    entry.clients.delete(res);
    return;
  }

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(hb);
    entry.clients.delete(res);
  });
});

// ---- GET /api/file/:id : serve a stored file ----
app.get("/api/file/:id", async (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id);

  if (!meta) {
    return res.status(404).json({ error: "File not found or expired." });
  }

  if (Date.now() > meta.expiresAt) {
    deleteStoredFile(id, meta.ext);
    return res.status(410).json({ error: "Download link expired." });
  }

  const filePath = join(DOWNLOADS_DIR, `${id}.${meta.ext}`);
  if (!existsSync(filePath)) {
    deleteStoredFile(id, meta.ext);
    return res.status(404).json({ error: "File not found." });
  }

  const mime = meta.ext === "mp3" ? "audio/mpeg" : meta.ext === "zip" ? "application/zip" : "video/mp4";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", meta.size);
  res.setHeader("Content-Disposition", `attachment; filename="${meta.filename}"`);
  res.setHeader("Cache-Control", "no-store");

  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: "Failed to send file." });
    }
  });
});

// ---- global JSON error handler (prevents Express from returning HTML errors) ----
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error. Please try again." });
  }
});

// ---- cleanup interval ----
setInterval(runCleanupJob, 60_000);

// ---- session token cleanup ----
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > SESSION_TTL) sessions.delete(k);
  }
}, 60_000);

app.listen(PORT, () => {
  console.log(`\n  ▸ grab running at  http://localhost:${PORT}`);
  console.log(`  ▸ ffmpeg dir:   ${FFMPEG_DIR}`);
  console.log(`  ▸ downloads:    ${DOWNLOADS_DIR}`);
  console.log(`  ▸ cache:        ${cacheStats().entries} entries\n`);
});
