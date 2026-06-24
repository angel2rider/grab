// Apple Music matcher — resolves song metadata via the iTunes Lookup API (no auth),
// then matches to YouTube. Audio is never pulled from Apple Music.

import { findMatch } from "../search.js";

function parseUrl(url) {
  const m = String(url).match(
    /music\.apple\.com\/([a-z]{2})\/(album|playlist)\/[^/]+\/(?:pl\.|)?([A-Za-z0-9.]+)/i
  );
  // Song URL: music.apple.com/us/song/slug/123456
  if (!m) {
    const sm = String(url).match(
      /music\.apple\.com\/[a-z]{2}\/song\/[^/]+\/([0-9]+)/i
    );
    return sm ? { kind: "track", id: sm[1] } : null;
  }
  return m ? { kind: m[2], id: m[3] } : null;
}

async function itunesLookup(id) {
  const r = await fetch(
    `https://itunes.apple.com/lookup?id=${id}&entity=song`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data.results?.[0] || null;
}

// Decode HTML entities (iTunes returns e.g. "Redford (For Yia-Yia &amp; Pappou)").
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export async function resolveApple(url) {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error("Couldn't parse an Apple Music song URL.");

  if (parsed.kind !== "track") {
    throw new Error(
      "Apple Music albums/playlists can't be auto-enumerated from the public API. Paste individual song links."
    );
  }

  const t = await itunesLookup(parsed.id);
  if (!t) throw new Error("Couldn't resolve this Apple Music song via iTunes Lookup.");

  const meta = {
    title: decodeEntities(t.trackName),
    artist: decodeEntities(t.artistName),
    album: decodeEntities(t.collectionName),
    trackNo: t.trackNumber,
    year: t.releaseDate?.slice(0, 4),
    artwork: t.artworkUrl100?.replace("100x100bb", "600x600bb") || null,
  };

  const match = await findMatch(meta);
  if (!match) throw new Error("No YouTube match found for this Apple Music song.");
  return {
    kind: "single",
    sourcePlatform: "apple",
    tracks: [{ ...meta, resolvedUrl: match.url, matchedBy: match.matchedBy }],
  };
}
