// Qobuz matcher — resolves track metadata, then matches to YouTube.
// Qobuz pages are JS-rendered with no server-side metadata in og:tags.
// Strategy: extract slug from URL → Deezer free search API as metadata source →
// fall back to slug-as-query → match on YouTube. Audio is never pulled from Qobuz.

import { findMatch } from "../search.js";

function parseUrl(url) {
  try {
    const path = new URL(url).pathname;
    // /us-en/track/artist-title/2u2xaw1jlsgvx  OR  /gb-en/album/.../0825646002728
    const m = path.match(/\/(?:track|album)\/([^/]+)\/([A-Za-z0-9]+)/i);
    return m ? { kind: path.includes("/track/") ? "track" : "album", slug: m[1], id: m[2] } : null;
  } catch {
    return null;
  }
}

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

export async function resolveQobuz(url) {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error("Couldn't parse a Qobuz track URL.");
  if (parsed.kind !== "track") {
    throw new Error(
      "Qobuz albums can't be auto-enumerated (pages are JS-rendered). Paste individual track links."
    );
  }

  // Slug like "rick-astley-never-gonna-give-you-up" → search text.
  const queryText = parsed.slug.replace(/-/g, " ").trim();
  const meta = await deezerLookup(queryText);

  const trackMeta = {
    title: meta?.title || queryText,
    artist: meta?.artist || null,
    album: "",
    isrc: meta?.isrc || null,
    artwork: null,
  };

  const match = await findMatch(trackMeta);
  if (!match) throw new Error("No YouTube match found for this Qobuz track.");
  return {
    kind: "single",
    sourcePlatform: "qobuz",
    tracks: [{ ...trackMeta, resolvedUrl: match.url, matchedBy: match.matchedBy }],
  };
}
