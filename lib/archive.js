// Batch download → ZIP stored on disk. Downloads each item with downloadOne,
// optionally tags matched audio with source metadata, then writes a zip to
// the specified outDir with the given basename.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createWriteStream } = require("fs");
const { pipeline } = require("node:stream/promises");
import { downloadOne, cleanup, makeTempDir, sanitizeFilename } from "./ytdlp.js";
import { tagMp3 } from "./tagging.js";
import { join } from "node:path";

/**
 * Download many items and store them as a zip file on disk.
 *
 * @param {object} opts
 * @param {Array} opts.items        - each: { url, mode, title, formatId?, meta? }
 * @param {string} opts.ffmpegDir
 * @param {string} opts.outDir       - directory to write the zip into
 * @param {string} opts.basename     - filename stem for the zip (without .zip)
 * @param {string} opts.zipName      - display name used for entries inside the zip
 * @returns {Promise<{ filePath: string, ext: string }>}
 */
export async function downloadZip({ items, ffmpegDir, outDir, basename, zipName }) {
  // Use a temp work dir for individual downloads → one cleanup target.
  const workDir = await makeTempDir();
  const zipPath = join(outDir, `${basename || "download"}.zip`);

  const archive = new (require("archiver"))("zip", { zlib: { level: 0 } });

  const output = createWriteStream(zipPath);

  // Pipeline: archive → write stream. This waits for the zip to finish writing.
  const archiveDone = pipeline(
    archive,
    output
  );

  archive.on("error", (err) => {
    console.error("zip error:", err.message);
  });

  const usedNames = new Set();
  const uniqueName = (base, ext) => {
    let n = `${base}.${ext}`;
    let i = 2;
    while (usedNames.has(n.toLowerCase())) {
      n = `${base} (${i}).${ext}`;
      i++;
    }
    usedNames.add(n.toLowerCase());
    return n;
  };

  // Download each item into the shared dir with a unique basename
  let idx = 0;
  for (const item of items) {
    idx++;
    try {
      const result = await downloadOne({
        url: item.url,
        mode: item.mode || "audio",
        formatId: item.formatId,
        title: item.title,
        ffmpegDir,
        outDir: workDir,
        basename: `item${idx}`,
      });

      // Tag matched audio with source metadata (Spotify/Tidal/etc.)
      if (result.ext === "mp3" && item.meta) {
        try {
          await tagMp3(result.filePath, item.meta);
        } catch (e) {
          console.error("tag failed (non-fatal):", e.message);
        }
      }

      const name = uniqueName(sanitizeFilename(item.title || `track ${idx}`), result.ext);
      archive.file(result.filePath, { name });
    } catch (e) {
      console.error(`skipped item "${item.title}":`, e.message);
      archive.append(
        `Couldn't download: ${item.title || item.url}\nReason: ${e.message}\n`,
        { name: uniqueName("_FAILED_" + sanitizeFilename(item.title || `track ${idx}`), "txt") }
      );
    }
  }

  archive.finalize();
  await archiveDone;
  await cleanup(workDir);

  return { filePath: zipPath, ext: "zip" };
}
