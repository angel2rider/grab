// Tidal matcher — resolves track metadata, then matches to YouTube.
// Tidal pages are JS-rendered with no server-side metadata in og:tags or JSON-LD,
// and their API needs auth. Strategy: extract any slug from the URL → use Deezer's
// free search API to enrich with artist/title/ISRC → fall back to slug-as-query →
// match on YouTube. Audio is never pulled from Tidal.

import { findMatch } from "../search.js";

function parseTrack(url) {
  try {
    const path = new URL(url).pathname;
    // Accept: /track/123456  OR  /track/slug-name/123456
    const m = path.match(/\/track\/([^/]+)\/?(\d+)?$/i);
    if (!m) return null;
    return { slug: m[1], id: m[2] || null };
  } catch {
    return null;
  }
}

/** Try Deezer's public search API (no auth) to enrich a query with ISRC. */
async function deezerLookup(query) {
  try {
    const r = await fetch(
      `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const t = data.data?.[0];
    if (!t) return null;
    return { title: t.title, artist: t.artist?.name, isrc: t.isrc };
  } catch {
    return null;
  }
}

export async function resolveTidal(url) {
  const parsed = parseTrack(url);
  if (!parsed) throw new Error("Couldn't parse a Tidal track URL.");

  // A slug is present only when the URL is /track/slug-name/ID.
  // A bare /track/ID gives us no searchable text.
  const hasSlug = parsed.slug && !/^\d+$/.test(parsed.slug);
  const queryText = hasSlug ? parsed.slug.replace(/-/g, " ") : null;

  if (!queryText) {
    throw new Error(
      "This Tidal link has no track name in the URL, and Tidal's pages require login to read. " +
      "Try a Tidal link that includes the track name, or paste the track directly from YouTube/SoundCloud."
    );
  }

  const meta = await deezerLookup(queryText);
  const trackMeta = {
    title: meta?.title || queryText,
    artist: meta?.artist || null,
    album: "",
    isrc: meta?.isrc || null,
    artwork: null,
  };

  const match = await findMatch(trackMeta);
  if (!match) throw new Error("No YouTube match found for this Tidal track.");
  return {
    kind: "single",
    sourcePlatform: "tidal",
    tracks: [{ ...trackMeta, resolvedUrl: match.url, matchedBy: match.matchedBy }],
  };
}
