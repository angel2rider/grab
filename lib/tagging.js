// Embed ID3 tags + album art into a matched MP3, using the metadata sourced
// from the original DRM service (Spotify/Tidal/Qobuz/Apple Music).

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const NodeID3 = require("node-id3");

/**
 * Tag an MP3 file in place with the given metadata.
 * @param {string} filePath - path to the .mp3 to rewrite
 * @param {object} meta
 * @param {string} meta.title
 * @param {string|string[]} meta.artist
 * @param {string} [meta.album]
 * @param {number} [meta.trackNo]
 * @param {string} [meta.year]
 * @param {Buffer|string} [meta.image] - album art bytes, or URL (fetched by caller)
 */
export async function tagMp3(filePath, meta) {
  const tags = {
    title: meta.title,
    artist: Array.isArray(meta.artist) ? meta.artist.join(", ") : meta.artist,
    album: meta.album || "",
    trackNo: meta.trackNo ? String(meta.trackNo) : undefined,
    year: meta.year || undefined,
  };

  if (meta.image) {
    let imageBuffer = meta.image;
    if (typeof meta.image === "string") {
      try {
        const r = await fetch(meta.image);
        if (r.ok) {
          imageBuffer = Buffer.from(await r.arrayBuffer());
        }
      } catch {
        /* non-fatal: skip art */
      }
    }
    if (Buffer.isBuffer(imageBuffer)) {
      tags.image = {
        mime: "image/jpeg",
        type: { id: 3, name: "front cover" },
        description: "Cover",
        imageBuffer,
      };
    }
  }

  // NodeID3.write with a file path writes tags directly to that file and
  // returns the updated Buffer (sync-style). No separate writeFile needed.
  return new Promise((resolve, reject) => {
    NodeID3.write(tags, filePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
