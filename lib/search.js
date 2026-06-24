// Find the best audio source on YouTube for a given track.
//
// Strategy (in priority order):
//   1. ISRC search on YouTube Music — ISRC is the gold-standard cross-service ID,
//      so a hit here is almost always the exact track.
//   2. YouTube Music search by "artist - title" — ISRC-free fallback.
//   3. Plain YouTube search by "artist - title" — last resort.
//
// We use yt-dlp's ytsearch / ytmsearch to avoid needing a YouTube API key.

import { runYtDlp } from "./ytdlp.js";

/**
 * Resolve a DRM-service track to a downloadable YouTube URL.
 * @param {object} track  - { title, artist (string|array), isrc? }
 * @returns {Promise<{url: string, title: string, matchedBy: string} | null>}
 */
export async function findMatch(track) {
  const artist = Array.isArray(track.artist)
    ? track.artist.join(", ")
    : track.artist;
  const queryText = `${artist} - ${track.title}`.trim();

  const candidates = [];
  if (track.isrc) {
    candidates.push({ q: track.isrc, by: `ISRC (${track.isrc})`, scope: "ytmsearch" });
  }
  candidates.push({ q: queryText, by: "title", scope: "ytmsearch" });
  candidates.push({ q: queryText, by: "title", scope: "ytsearch" });

  for (const c of candidates) {
    const url = `${c.scope}1:${c.q}`; // take first result
    try {
      // Lightweight: just resolve the URL + title, no full format dump.
      const out = await runYtDlp(
        [url, "--get-title", "--get-id", "--no-warnings", "--no-playlist", "--no-progress"],
        { timeout: 25000 }
      );
      const lines = out.trim().split("\n").filter(Boolean);
      if (lines.length >= 2) {
        const [title, id] = lines;
        return {
          url: `https://www.youtube.com/watch?v=${id}`,
          title,
          matchedBy: c.by,
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
