// Generalized yt-dlp wrappers — work for ANY site yt-dlp supports.
// Extracted from the original YouTube-only server.js.

import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm, stat, mkdir, rename, unlink } from "node:fs/promises";
import { createReadStream, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const YT_DLP = process.env.YT_DLP || "yt-dlp";

// Netscape-format cookie file for yt-dlp. Uses cookies.txt in project root if it exists.
// Set COOKIES_FILE env var to override, or set to empty to disable.
const COOKIES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "cookies.txt");
let COOKIES_FILE = process.env.COOKIES_FILE;
if (COOKIES_FILE === undefined) {
  try { statSync(COOKIES_PATH); COOKIES_FILE = COOKIES_PATH; } catch { COOKIES_FILE = ""; }
}
const COOKIES_ARGS = COOKIES_FILE ? ["--cookies", COOKIES_FILE] : [];
if (COOKIES_FILE) console.log(`  ▸ cookies:     ${COOKIES_FILE}`);

// JS runtime for YouTube EJS challenge solving (signatures / n parameter).
// yt-dlp 2026 requires a JS runtime. Node v22+ is ideal, Deno also works.
const JS_RUNTIME = process.env.YT_DLP_JS_RUNTIME || "node";
const JS_RUNTIME_ARGS = JS_RUNTIME ? ["--js-runtimes", JS_RUNTIME] : [];
if (JS_RUNTIME) console.log(`  ▸ js-runtime:  ${JS_RUNTIME}`);

/** Run yt-dlp and resolve with its stdout (string), rejecting on failure. */
export function runYtDlp(args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const allArgs = [...JS_RUNTIME_ARGS, ...COOKIES_ARGS, ...args];
    const child = spawn(YT_DLP, allArgs, { timeout });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", () => reject(new Error("yt-dlp failed to launch.")));
    child.on("close", (code) => {
      if (code !== 0) {
        const msg = (err || "").trim() || `yt-dlp exited with code ${code}.`;
        reject(new Error(msg));
      } else {
        resolve(out);
      }
    });
  });
}

/**
 * Fetch full metadata for a single URL, with UI-friendly grouped formats.
 * Returns the same shape the frontend already consumes.
 */
export async function getInfo(url) {
  const out = await runYtDlp(
    [url, "--dump-json", "--no-warnings", "--no-playlist", "--no-progress", "--no-check-formats"],
    { timeout: 30000 }
  );
  const meta = JSON.parse(out.trim().split("\n").pop());
  return {
    kind: "single",
    platform: null, // filled in by caller (detect)
    sourceUrl: url,
    id: meta.id,
    title: meta.title,
    channel: meta.channel || meta.uploader || meta.uploader_id,
    duration: meta.duration,
    thumbnail:
      (meta.thumbnail || "").replace(/^http:/, "https:") ||
      (meta.thumbnails?.at(-1)?.url || "").replace(/^http:/, "https:"),
    viewCount: meta.view_count,
    uploadDate: meta.upload_date,
    webpageUrl: meta.webpage_url || url,
    isAudioOnly: !meta.width && !meta.height && !!meta.abr,
    formats: collectFormats(meta),
  };
}

/**
 * Quickly list all entries in a URL (playlist/album/channel) without resolving
 * each one. Uses --flat-playlist for speed.
 * Returns { kind: 'multi', items: [...] } or { kind: 'single', ...getInfo }.
 */
export async function listEntries(url) {
  // First, a flat dump to see how many entries there are.
  let flatOut;
  try {
    flatOut = await runYtDlp(
      [url, "--flat-playlist", "--dump-json", "--no-warnings", "--no-progress"],
      { timeout: 30000 }
    );
  } catch (e) {
    // Some single-video URLs fail with --flat-playlist; fall back to full info.
    return getInfo(url);
  }

  const lines = flatOut.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return getInfo(url);

  // A single entry that's actually a full info dict (not a flat playlist row)
  // has a "formats" array — treat it as a single item.
  const first = JSON.parse(lines[0]);
  if (lines.length === 1 && Array.isArray(first.formats)) {
    return getInfo(url);
  }

  const items = lines.map((line, i) => {
    const e = JSON.parse(line);
    return {
      index: i,
      title: e.title || e.fulltitle || `Item ${i + 1}`,
      duration: e.duration,
      thumbnail: (e.thumbnail || e.thumbnails?.at(-1)?.url || "").replace(
        /^http:/,
        "https:"
      ),
      // For playlists, yt-dlp gives us the entry's own URL via webpage_url / url,
      // or a relative id we can pass back with the playlist parent + --playlist-items.
      url:
        e.url ||
        e.webpage_url ||
        (e.id ? `${url}&playlist-items=${i + 1}` : url),
      id: e.id,
    };
  });

  return { kind: "multi", items, sourceUrl: url };
}

// ---- format grouping — resolution tiers with all codecs ----

const CODEC_RANK = { av1: 4, av01: 4, hevc: 3, h265: 3, vp9: 3, vp09: 3, avc: 2, avc1: 2, h264: 2 };
function codecDisplayName(vcodec) {
  if (!vcodec || vcodec === "none") return null;
  const k = vcodec.split(".")[0].toLowerCase();
  if (k.includes("av01") || k === "av1") return { name: "AV1", id: "av1" };
  if (k.includes("hevc") || k.includes("h265")) return { name: "H.265", id: "h265" };
  if (k.includes("vp9") || k.includes("vp09")) return { name: "VP9", id: "vp9" };
  if (k.includes("avc") || k.includes("avc1") || k.includes("h264")) return { name: "H.264", id: "h264" };
  return { name: k.toUpperCase(), id: k };
}
function codecRank(vcodec) {
  const c = codecDisplayName(vcodec);
  return c ? (CODEC_RANK[c.id] || 0) : 0;
}

function collectFormats(meta) {
  // --- video-only streams: group by resolution, then by codec ---
  const byRes = new Map(); // height → codecId → [formats]
  for (const f of meta.formats || []) {
    const hasV = (f.vcodec && f.vcodec !== "none") || f.height;
    const hasA = (f.acodec && f.acodec !== "none") || f.abr;
    if (!hasV || hasA) continue;
    if (f.format_id && /^(sb|c\d|rr)/.test(f.format_id)) continue;
    if (!f.vcodec || f.vcodec === "none") continue;
    const h = f.height || 0;
    if (!h) continue;
    const cd = codecDisplayName(f.vcodec);
    if (!cd) continue;

    if (!byRes.has(h)) byRes.set(h, new Map());
    const codecMap = byRes.get(h);
    if (!codecMap.has(cd.id)) codecMap.set(cd.id, []);
    codecMap.get(cd.id).push({
      formatId: f.format_id,
      codec: cd.name,
      codecId: cd.id,
      ext: f.ext || "mp4",
      height: h,
      filesize: f.filesize || f.filesize_approx,
      fps: f.fps || 0,
      vcodec: f.vcodec,
      vbr: f.vbr || f.tbr || 0,
    });
  }

  // For each (height, codec) pair, pick the highest bitrate format
  const formatByRes = {};
  const resolutions = [...byRes.keys()].sort((a, b) => b - a);
  for (const h of resolutions) {
    formatByRes[h] = [];
    for (const [codecId, fmts] of byRes.get(h)) {
      fmts.sort((a, b) => (b.vbr || b.fps || b.filesize || 0) - (a.vbr || a.fps || a.filesize || 0));
      const best = fmts[0];
      // Skip low-bitrate dupes (prefer codec with best quality)
      formatByRes[h].push({
        formatId: best.formatId,
        codec: best.codec,
        codecId: best.codecId,
        ext: best.ext,
        height: best.height,
        fps: best.fps,
        filesize: best.filesize,
        vcodec: best.vcodec,
      });
    }
    // Sort codecs within resolution by quality rank
    formatByRes[h].sort((a, b) => codecRank(b.vcodec) - codecRank(a.vcodec));
  }

  const video = { byRes: formatByRes, resolutions };

  // --- audio-only streams ---
  const auds = [];
  for (const f of meta.formats || []) {
    const hasV = (f.vcodec && f.vcodec !== "none") || f.height;
    const hasA = (f.acodec && f.acodec !== "none") || f.abr;
    if (hasV || !hasA) continue;
    auds.push({
      formatId: f.format_id,
      ext: f.ext || "m4a",
      abr: f.abr,
      filesize: f.filesize || f.filesize_approx,
      label: f.abr ? `${Math.round(f.abr)} kbps` : (f.ext || "audio").toUpperCase(),
    });
  }
  auds.sort((a, b) => (b.abr || 0) - (a.abr || 0));

  // --- combined (progressive) streams ---
  const combined = [];
  for (const f of meta.formats || []) {
    const hasV = (f.vcodec && f.vcodec !== "none") || f.height;
    const hasA = (f.acodec && f.acodec !== "none") || f.abr;
    if (!hasV || !hasA || !f.ext) continue;
    const h = f.height || 0;
    const fpsLabel = f.fps >= 50 ? f.fps : "";
    combined.push({
      formatId: f.format_id,
      ext: f.ext,
      height: h,
      filesize: f.filesize || f.filesize_approx,
      fps: f.fps || 0,
      label: `${h || "?"}p${fpsLabel}`,
      isMux: false,
    });
  }
  combined.sort((a, b) => (b.height || 0) - (a.height || 0));

  const bestAudioSize = auds[0]?.filesize || null;

  return { video, audio: dedupe(auds), combined: dedupe(combined), bestAudioSize };
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter((f) => {
    const key = `${f.label}-${f.ext}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- downloading ----

/** Regex to parse yt-dlp progress lines:
 *  [download]  45.2% of ~30.58MiB at  8.21MiB/s ETA 00:02
 */
const PROGRESS_RE = /^\[download\]\s+([0-9.]+)%/;

export function sanitizeFilename(name) {
  return (name || "media")
    .replace(/[^\w\d\- .()\[\]]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180) || "media";
}

/**
 * Resolve ffmpeg executable path — check common locations, fall back to PATH.
 */
function resolveFfmpegPath() {
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
      return c;
    } catch {}
  }
  return "ffmpeg";
}

/**
 * Check if a file is a valid MP4 by reading its ftyp box header.
 */
function isMp4File(filePath) {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(12);
    readSync(fd, buf, 0, 12, 0);
    closeSync(fd);
    return buf.slice(4, 8).toString() === "ftyp";
  } catch {
    return false;
  }
}

/**
 * Convert a video file to MP4 using ffmpeg.
 * Tries fast remux first (copy codecs), falls back to re-encode if needed.
 */
export async function ensureMp4(filePath, onProgress) {
  // If already a valid .mp4, skip
  if (filePath.toLowerCase().endsWith(".mp4")) {
    if (isMp4File(filePath)) return filePath;
  }

  const outPath = filePath.replace(/\.[^.]+$/, "") + ".mp4";
  const ffmpeg = resolveFfmpegPath();
  if (onProgress) onProgress({ percent: 0, step: "Converting to MP4…", speed: "", eta: "" });

  // Try fast remux first (copy codecs without re-encoding)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, [
        "-i", filePath,
        "-c:v", "copy",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-y", outPath,
      ]);
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.slice(-200)));
      });
    });

    if (isMp4File(outPath)) {
      await unlink(filePath).catch(() => {});
      if (onProgress) onProgress({ percent: 100, step: "Download complete", speed: "", eta: "" });
      return outPath;
    }
  } catch {}
  // Fall through to re-encode

  // Re-encode to H.264 + AAC
  if (onProgress) onProgress({ percent: 0, step: "Re-encoding to MP4…", speed: "", eta: "" });
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-i", filePath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outPath,
    ]);
    let stderr = "";
    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      // Parse ffmpeg time to show progress
      if (onProgress) {
        const timeMatch = chunk.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
        if (timeMatch) {
          const sec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
          onProgress({ percent: null, step: `Converting to MP4… (${sec}s processed)`, speed: "", eta: "" });
        }
      }
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("close", async (code) => {
      if (code !== 0) {
        // If output already exists from a partial run, keep it
        try { await stat(outPath); return resolve(outPath); } catch {}
        return reject(new Error("FFmpeg conversion to MP4 failed."));
      }
      try {
        await stat(outPath);
        await unlink(filePath).catch(() => {});
        if (onProgress) onProgress({ percent: 100, step: "Download complete", speed: "", eta: "" });
        resolve(outPath);
      } catch {
        reject(new Error("Converted MP4 not found."));
      }
    });
  });
}

/**
 * Download a single item to a file inside a fresh temp dir.
 * @param {object} opts
 * @param {string} opts.url        - source URL (already resolved for match sources)
 * @param {string} opts.mode       - 'audio' | 'video-combined' | 'video'
 * @param {string} [opts.formatId]
 * @param {string} [opts.title]    - for filename
 * @param {string} opts.ffmpegDir
 * @param {string} [opts.outDir]   - if provided, write into this dir instead of a fresh one (for batch)
 * @param {string} [opts.basename] - basename to use when outDir is provided (default "out")
 * @param {function} [opts.onProgress] - callback({ percent, speed, eta, step })
 * @returns {Promise<{filePath: string, dir: string, ext: string}>}
 */
export function downloadOne({ url, mode, formatId, title, ffmpegDir, outDir, basename, onProgress }) {
  return new Promise(async (resolve, reject) => {
    let workDir;
    if (outDir) {
      workDir = outDir;
    } else {
      try {
        workDir = await mkdtemp(join(tmpdir(), "ytgrab-"));
      } catch {
        return reject(new Error("Could not create temp workspace."));
      }
    }

    const ext = mode === "audio" ? "mp3" : "mp4";
    const outFile = join(workDir, `${basename || "out"}.${ext}`);

    /** Build the yt-dlp args for a given format selector. */
    function buildArgs(formatSelOverride) {
      let formatSel;
      let extra = [];
      if (mode === "audio") {
        formatSel = "bestaudio/best";
        const audioQuality = { "320": "0", "256": "2", "192": "4", "128": "5" }[formatId] || "0";
        extra = [
          "-x", "--audio-format", "mp3", "--audio-quality", audioQuality,
          "--ffmpeg-location", ffmpegDir,
        ];
      } else if (mode === "video-combined") {
        formatSel = formatSelOverride || "best";
        extra = ["--remux-video", "mp4", "--ffmpeg-location", ffmpegDir];
      } else {
        formatSel = formatSelOverride || (formatId
          ? `${formatId}+bestaudio/best`
          : "bestvideo+bestaudio/best");
        extra = ["--merge-output-format", "mp4", "--remux-video", "mp4", "--ffmpeg-location", ffmpegDir];
      }

      return [
        ...JS_RUNTIME_ARGS,
        ...COOKIES_ARGS,
        url, "-f", formatSel, "-o", outFile,
        "--no-warnings", "--newline",
        "--concurrent-fragments", "4",
        "--buffer-size", "16K",
        "--http-chunk-size", "10M",
        ...extra,
      ];
    }

    /** Spawn yt-dlp and return { code, stderr } */
    function runDownload(args) {
      return new Promise((resolveSpawn) => {
        const child = spawn(YT_DLP, args, { timeout: 600000 });
        let outputBuf = "";     // combined stdout + stderr for progress parsing
        let errLines = "";       // preserved for error diagnostics (non-progress stderr lines)

        // yt-dlp outputs download progress to stdout (and optionally stderr),
        // so we listen to BOTH streams for progress lines.
        const handleOutput = (d) => {
          const chunk = d.toString();
          outputBuf += chunk;
          if (outputBuf.length > 8000) {
            const sliceStart = outputBuf.indexOf("\n", outputBuf.length - 8000);
            outputBuf = outputBuf.slice(sliceStart !== -1 ? sliceStart + 1 : -8000);
          }
          if (onProgress) {
            let nlIdx;
            while ((nlIdx = outputBuf.indexOf("\n")) !== -1) {
              const line = outputBuf.slice(0, nlIdx);
              outputBuf = outputBuf.slice(nlIdx + 1);
              const m = line.match(PROGRESS_RE);
              const isProgress = line.includes("[Merger]") || line.includes("[Remux]") || line.includes("[ExtractAudio]");
              if (m) {
                const percent = parseFloat(m[1]);
                const speedMatch = line.match(/at\s+([^\s]+)\s/);
                const etaMatch = line.match(/ETA\s+([^\s]+)/);
                const isConverting = line.includes("[ExtractAudio]");
                onProgress({
                  percent: Math.min(percent, 99),
                  step: isConverting ? "Downloading & converting…" : `Downloading… ${Math.round(percent)}%`,
                  speed: speedMatch ? speedMatch[1] : "",
                  eta: etaMatch ? etaMatch[1] : "",
                });
              } else if (isProgress) {
                onProgress({ percent: 95, step: "Processing video…", speed: "", eta: "" });
              }
            }
          }
        };

        child.stdout.on("data", handleOutput);
        child.stderr.on("data", (d) => {
          // Also pass stderr through progress parsing (some yt-dlp versions
          // emit progress on stderr), and preserve it for error diagnostics.
          handleOutput(d);
          // Accumulate stderr separately for error messages
          const chunk = d.toString();
          errLines += chunk;
          if (errLines.length > 8000) errLines = errLines.slice(-8000);
        });

        child.on("error", () => resolveSpawn({ code: -1, stderr: "yt-dlp failed to launch." }));
        child.on("close", (code) => {
          const fullStderr = errLines.trim();
          resolveSpawn({ code, stderr: fullStderr });
        });
      });
    }

    if (onProgress) onProgress({ percent: 0, step: "Starting yt-dlp…", speed: "", eta: "", status: "starting" });

    // First attempt with the user's selected format
    let args = buildArgs(null);
    let result = await runDownload(args);

    // If the specific format isn't available, retry once with best-available fallback
    const FORMAT_ERR_RE = /not available|Requested format/i;
    if (result.code !== 0 && formatId && mode !== "audio" && FORMAT_ERR_RE.test(result.stderr)) {
      console.log(`  ▸ retrying:   format ${formatId} unavailable, falling back to best`);
      if (onProgress) onProgress({ percent: 0, step: "Retrying with best available…", speed: "", eta: "", status: "starting" });
      // Build new args with fallback format selector, but keep the same outFile so it overwrites
      args = buildArgs("bestvideo+bestaudio/best");
      result = await runDownload(args);
    }

    if (result.code !== 0) {
      await cleanup(workDir);
      return reject(
        new Error(
          (result.stderr || "").trim() ||
            "Download failed. The format may be unavailable."
        )
      );
    }

    try {
      let finalPath = outFile;
      const finalExt = mode === "audio" ? "mp3" : "mp4";

      if (mode !== "audio") {
        if (onProgress) onProgress({ percent: 96, step: "Ensuring MP4 format…", speed: "", eta: "" });
        try {
          finalPath = await ensureMp4(outFile, onProgress);
        } catch (e) {
          console.error("MP4 conversion warning:", e.message);
        }
      }

      if (onProgress) onProgress({ percent: 100, step: "Download complete", speed: "", eta: "" });
      await stat(finalPath);
      resolve({ filePath: finalPath, dir: workDir, ext: finalExt });
    } catch {
      await cleanup(workDir);
      reject(new Error("Output file not found after download."));
    }
  });
}

/** Stream a completed file to an Express response. Returns when done. */
export async function streamFile(res, filePath, filename, mime) {
  const size = (await stat(filePath)).size;
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", size);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );
  res.setHeader("Cache-Control", "no-store");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("close", resolve);
    stream.pipe(res);
  });
}

export async function cleanup(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "ytgrab-"));
}
