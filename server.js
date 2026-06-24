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

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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
  // Update stored state
  Object.assign(entry, data);
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of entry.clients) {
    try { client.write(msg); } catch {}
  }
  // If terminal state, close all clients and clean up
  if (data.status === "complete" || data.status === "error") {
    for (const client of entry.clients) {
      try { client.end(); } catch {}
    }
    entry.clients.clear();
    // Remove from store after a delay
    setTimeout(() => progressStore.delete(token), 60_000);
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
app.get("/api/info", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Please paste a valid video or music link." });
  }

  const { type, platform } = detect(url);
  const platformMeta = PLATFORM_META[platform] || PLATFORM_META.generic;

  try {
    if (type === "match") {
      const result = await resolveMatch(platform, url);
      return res.json({ sourceType: "match", platform, platformMeta, ...result });
    }

    const info = await listEntries(url);
    const resp = {
      sourceType: "direct",
      platform,
      platformMeta,
      ...info,
    };
    resp.platform = platform;
    return res.json(resp);
  } catch (e) {
    return res.status(422).json({ error: e.message || "Couldn't resolve this link." });
  }
});

// ---- POST /api/prepare : stash a download job, return a token ----
app.post("/api/prepare", (req, res) => {
  const body = req.body || {};
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
app.post("/api/download", async (req, res) => {
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
  broadcastProgress(token, { status: "downloading", percent: 0, step: "Starting…", speed: "", eta: "" });

  if (entry.kind === "zip") {
    // ZIP batch download
    const items = entry.items;
    broadcastProgress(token, { status: "downloading", percent: 0, step: `Preparing archive (0/${items.length})…`, speed: "", eta: "" });

    try {
      const { filePath, ext } = await downloadZip({
        items,
        ffmpegDir: FFMPEG_DIR,
        outDir: DOWNLOADS_DIR,
        basename: fileId,
        zipName: entry.zipName,
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
        percent: 100, step: "Complete",
        fileId, downloadUrl: `/api/file/${fileId}`, filename, size: fileSize, aliveMinutes: Math.round(aliveTime / 60000),
      });
    } catch (e) {
      broadcastProgress(token, { status: "error", error: e.message });
    }
    return;
  }

  // Single item download with progress callback
  const onProgress = (prog) => {
    broadcastProgress(token, {
      status: "downloading",
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
      broadcastProgress(token, { status: "downloading", percent: 97, step: "Tagging metadata…", speed: "", eta: "" });
      try {
        await tagMp3(filePath, entry.meta);
      } catch (e) {
        console.error("tag failed (non-fatal):", e.message);
      }
    }

    // Move file to persistent storage
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
      percent: 100, step: "Complete",
      fileId, downloadUrl: `/api/file/${fileId}`, filename, size: fileSize, aliveMinutes: Math.round(aliveTime / 60000),
    });
  } catch (e) {
    broadcastProgress(token, { status: "error", error: e.message, percent: 0, step: "Failed" });
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

  // Send current state immediately
  const currentState = {
    status: entry.status,
    percent: entry.percent,
    step: entry.step,
    speed: entry.speed || "",
    eta: entry.eta || "",
  };
  res.write(`data: ${JSON.stringify(currentState)}\n\n`);

  // If already in terminal state, close with result data
  if (entry.status === "complete") {
    res.write(`data: ${JSON.stringify({
      status: "complete", percent: 100, step: "Complete",
      fileId: entry.fileId, downloadUrl: entry.downloadUrl,
      filename: entry.filename, size: entry.size, aliveMinutes: entry.aliveMinutes,
    })}\n\n`);
    return res.end();
  }
  if (entry.status === "error") {
    res.write(`data: ${JSON.stringify({ status: "error", error: entry.error || "Download failed." })}\n\n`);
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
      ? { status: "complete", percent: 100, step: "Complete",
          fileId: entry.fileId, downloadUrl: entry.downloadUrl,
          filename: entry.filename, size: entry.size, aliveMinutes: entry.aliveMinutes }
      : { status: "error", error: entry.error || "Download failed." };
    try {
      res.write(`data: ${JSON.stringify(terminalData)}\n\n`);
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
  console.log(`  ▸ downloads:    ${DOWNLOADS_DIR}\n`);
});
