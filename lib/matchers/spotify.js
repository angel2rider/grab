// Spotify matcher — resolves track/album/playlist metadata.
//
// Auth model (resilient to Spotify's deprecation of Client Credentials):
//   - If SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET are set, use the Web API
//     (needed for albums/playlists, which list many tracks with ISRCs).
//   - Otherwise fall back to the auth-free Spotify oEmbed endpoint for single
//     tracks (returns title only — no ISRC, so matching falls back to title).
//
// Audio is NEVER pulled from Spotify; we resolve metadata, then match to YouTube.

import { findMatch } from "../search.js";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
let tokenCache = null; // { token, expiresAt }

async function getApiToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) return null;
  const data = await r.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return tokenCache.token;
}

async function apiGet(path) {
  const token = await getApiToken();
  if (!token) return null;
  const r = await fetch(`https://api.spotify.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

function parseId(url) {
  const m = String(url).match(/\/(track|album|playlist)\/([A-Za-z0-9]+)/);
  return m ? { kind: m[1], id: m[2] } : null;
}

function artistNames(item) {
  return (item.artists || []).map((a) => a.name);
}

function toTrack(item, albumName) {
  return {
    title: item.name,
    artist: artistNames(item),
    album: albumName || item.album?.name || "",
    trackNo: item.track_number,
    duration: Math.round((item.duration_ms || 0) / 1000),
    isrc: item.external_ids?.isrc,
    artwork:
      item.album?.images?.[0]?.url || item.album?.images?.at(-1)?.url || null,
  };
}

/**
 * Resolve a Spotify URL into either a single track (resolved to a YouTube URL)
 * or a list of tracks. Each track carries `resolvedUrl` + `matchedBy` when a
 * YouTube match was found.
 *
 * @returns {Promise<{kind: 'single'|'multi', tracks: Track[], name?: string}>}
 */
export async function resolveSpotify(url) {
  const parsed = parseId(url);
  if (!parsed) throw new Error("Couldn't parse a Spotify track/album/playlist ID.");

  // ---- single track ----
  if (parsed.kind === "track") {
    const data = await apiGet(`tracks/${parsed.id}`);
    let track;
    if (data) {
      track = toTrack(data);
    } else {
      // Auth-free fallback: Spotify oEmbed gives the title (no ISRC/artist split).
      track = await oembedTrack(url);
    }
    const match = await findMatch(track);
    if (!match) throw new Error("No YouTube match found for this track.");
    return {
      kind: "single",
      sourcePlatform: "spotify",
      tracks: [{ ...track, resolvedUrl: match.url, matchedBy: match.matchedBy }],
    };
  }

  // ---- album ----
  if (parsed.kind === "album") {
    const data = await apiGet(`albums/${parsed.id}`);
    if (!data) {
      throw new Error(
        "Albums require Spotify API credentials (SPOTIFY_CLIENT_ID/SECRET). Set them to resolve albums & playlists."
      );
    }
    const albumName = data.name;
    const tracks = await Promise.all(
      (data.tracks?.items || []).map(async (item, i) => {
        const t = toTrack(item, albumName);
        const match = await findMatch(t);
        return {
          ...t,
          index: i,
          resolvedUrl: match?.url || null,
          matchedBy: match?.matchedBy || null,
        };
      })
    );
    return {
      kind: "multi",
      sourcePlatform: "spotify",
      name: `${albumName} — Spotify`,
      tracks,
    };
  }

  // ---- playlist ----
  if (parsed.kind === "playlist") {
    const data = await apiGet(`playlists/${parsed.id}?fields=name,tracks(items(track(name,artists,album,duration_ms,track_number,external_ids)))`);
    if (!data) {
      throw new Error(
        "Playlists require Spotify API credentials (SPOTIFY_CLIENT_ID/SECRET). Set them to resolve albums & playlists."
      );
    }
    const tracks = await Promise.all(
      (data.tracks?.items || []).map(async (entry, i) => {
        const item = entry?.track;
        if (!item) return null;
        const t = toTrack(item);
        const match = await findMatch(t);
        return {
          ...t,
          index: i,
          resolvedUrl: match?.url || null,
          matchedBy: match?.matchedBy || null,
        };
      })
    );
    return {
      kind: "multi",
      sourcePlatform: "spotify",
      name: `${data.name || "Playlist"} — Spotify`,
      tracks: tracks.filter(Boolean),
    };
  }

  throw new Error("Unsupported Spotify URL type.");
}

// Auth-free single-track metadata via oEmbed (title only).
async function oembedTrack(url) {
  try {
    const r = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`
    );
    if (!r.ok) throw new Error();
    const data = await r.json();
    // oEmbed title is usually "Artist - Title (feat. ...)"
    const parts = data.title.split(" - ");
    const hasSeparator = parts.length > 1;
    return {
      title: hasSeparator ? parts.slice(1).join(" - ") : data.title,
      artist: hasSeparator ? parts[0] : null,
      album: "",
      artwork: data.thumbnail_url || null,
    };
  } catch {
    throw new Error(
      "Couldn't resolve this Spotify track. Set SPOTIFY_CLIENT_ID/SECRET for reliable metadata."
    );
  }
}
