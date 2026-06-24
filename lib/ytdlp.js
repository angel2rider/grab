// Generalized yt-dlp wrappers — work for ANY site yt-dlp supports.
// Extracted from the original YouTube-only server.js.

import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm, stat, mkdir, rename, unlink } from "node:fs/promises";
import { createReadStream, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const YT_DLP = process.env.YT_DLP || "yt-dlp";

/** Run yt-dlp and resolve with its stdout (string), rejecting on failure. */
export function runYtDlp(args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, args, { timeout });
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

// ---- format grouping — resolution tiers with codec selection ----

const CODEC_PRIORITY = { av01: 3, vp9: 2, avc: 1, h264: 1, hevc: 2, h265: 2 };
function codecRank(vcodec) {
  if (!vcodec || vcodec === "none") return 0;
  const k = vcodec.split(".")[0].toLowerCase();
  for (const [prefix, rank] of Object.entries(CODEC_PRIORITY)) {
    if (k.includes(prefix)) return rank;
  }
  return 0;
}
function shortCodec(vcodec) {
  if (!vcodec || vcodec === "none") return "";
  const k = vcodec.split(".")[0].toUpperCase();
  return k;
}

function collectFormats(meta) {
  // --- video-only streams: group by resolution, pick best codec per tier ---
  const videoByRes = new Map(); // height → [formats]
  for (const f of meta.formats || []) {
    const hasV = (f.vcodec && f.vcodec !== "none") || f.height;
    const hasA = (f.acodec && f.acodec !== "none") || f.abr;
    if (!hasV || hasA) continue; // skip combined and audio-only
    // Skip storyboards (format_id like "sb*" / "c5" / "rr" — preview thumbnails, not real video)
    if (f.format_id && /^(sb|c\d|rr)/.test(f.format_id)) continue;
    if (!f.vcodec || f.vcodec === "none") continue;
    const h = f.height || 0;
    if (!h) continue;
    if (!videoByRes.has(h)) videoByRes.set(h, []);
    videoByRes.get(h).push({
      formatId: f.format_id,
      ext: f.ext || "mp4",
      height: h,
      filesize: f.filesize || f.filesize_approx,
      fps: f.fps || 0,
      vcodec: f.vcodec || "none",
      vbr: f.vbr || f.tbr || 0,
    });
  }

  // For each resolution, pick the format with highest codec rank, then highest bitrate
  const video = [];
  for (const [height, fmts] of [...videoByRes].sort((a, b) => b[0] - a[0])) {
    fmts.sort((a, b) => {
      const rd = codecRank(b.vcodec) - codecRank(a.vcodec);
      if (rd !== 0) return rd;
      return (b.vbr || b.fps) - (a.vbr || a.fps);
    });
    const best = fmts[0];
    const fpsLabel = best.fps >= 50 ? best.fps : "";
    const codecLabel = shortCodec(best.vcodec);
    video.push({
      formatId: best.formatId,
      ext: best.ext,
      height: best.height,
      filesize: best.filesize,
      fps: best.fps,
      vcodec: best.vcodec,
      label: `${height}p${fpsLabel}${codecLabel ? " " + codecLabel : ""}`,
      codecShort: codecLabel,
      isMux: true, // needs audio merge
    });
  }

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

  // Best audio (for estimated muxed size)
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
      if (onProgress) onProgress({ percent: 100, step: "Complete", speed: "", eta: "" });
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
        if (onProgress) onProgress({ percent: 100, step: "Complete", speed: "", eta: "" });
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
      formatSel = formatId || "best";
      extra = ["--remux-video", "mp4", "--ffmpeg-location", ffmpegDir];
    } else {
      formatSel = formatId
        ? `${formatId}+bestaudio/best`
        : "bestvideo+bestaudio/best";
      extra = ["--merge-output-format", "mp4", "--remux-video", "mp4", "--ffmpeg-location", ffmpegDir];
    }

    const args = [
      url, "-f", formatSel, "-o", outFile,
      "--no-warnings", "--newline",
      "--concurrent-fragments", "4",
      "--buffer-size", "16K",
      "--http-chunk-size", "10M",
      ...extra,
    ];

    if (onProgress) onProgress({ percent: 0, step: "Starting download…", speed: "", eta: "" });

    const child = spawn(YT_DLP, args, { timeout: 600000 });
    let stderrBuf = "";

    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderrBuf += chunk;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);

      if (onProgress) {
        const lines = chunk.split("\n");
        for (const line of lines) {
          const m = line.match(PROGRESS_RE);
          if (m) {
            const percent = parseFloat(m[1]);
            const speedMatch = line.match(/at\s+([^\s]+)\s/);
            const etaMatch = line.match(/ETA\s+([^\s]+)/);
            const isConverting = line.includes("[ExtractAudio]");
            onProgress({
              percent: Math.min(percent, 99),
              step: isConverting ? "Downloading & converting…" : "Downloading…",
              speed: speedMatch ? speedMatch[1] : "",
              eta: etaMatch ? etaMatch[1] : "",
            });
          }
          if (line.includes("[Merger]") || line.includes("[Remux]") || line.includes("[ExtractAudio]")) {
            onProgress({ percent: 95, step: "Processing…", speed: "", eta: "" });
          }
        }
      }
    });

    child.on("error", async () => {
      await cleanup(workDir);
      reject(new Error("yt-dlp failed to launch."));
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        await cleanup(workDir);
        return reject(
          new Error(
            (stderrBuf || "").trim() ||
              "Download failed. The format may be unavailable."
          )
        );
      }

      try {
        let finalPath = outFile;
        const finalExt = mode === "audio" ? "mp3" : "mp4";

        // For video, ensure output is always MP4 (remux/re-encode if needed)
        if (mode !== "audio") {
          if (onProgress) onProgress({ percent: 96, step: "Ensuring MP4 format…", speed: "", eta: "" });
          try {
            finalPath = await ensureMp4(outFile, onProgress);
          } catch (e) {
            console.error("MP4 conversion warning:", e.message);
          }
        }

        if (onProgress) onProgress({ percent: 100, step: "Complete", speed: "", eta: "" });
        await stat(finalPath);
        resolve({ filePath: finalPath, dir: workDir, ext: finalExt });
      } catch {
        await cleanup(workDir);
        reject(new Error("Output file not found after download."));
      }
    });
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
