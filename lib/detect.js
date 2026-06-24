// URL → source classification. Drives the router.
//
// Two kinds of sources:
//   "direct"  — yt-dlp handles it natively (YouTube, Vimeo, Instagram, TikTok,
//               X, Facebook, SoundCloud, Bandcamp, Twitch, Reddit, YT Music…).
//               We deliberately DON'T validate a list; yt-dlp decides.
//   "match"   — DRM-protected streaming services (Spotify, Tidal, Qobuz, Apple
//               Music). We read metadata, find the best match on YouTube/
//               SoundCloud, download that, and tag it with the original metadata.

const MATCH_HOSTS = {
  "spotify.com": "spotify",
  "tidal.com": "tidal",
  "qobuz.com": "qobuz",
  "music.apple.com": "apple",
};

// Friendly labels + accent colors for the UI badge.
export const PLATFORM_META = {
  youtube: { label: "YouTube", color: "#ff3850" },
  youtu: { label: "YouTube", color: "#ff3850" },
  vimeo: { label: "Vimeo", color: "#1ab7ea" },
  instagram: { label: "Instagram", color: "#e1306c" },
  tiktok: { label: "TikTok", color: "#25f4ee" },
  twitter: { label: "X", color: "#e7e9ea" },
  x: { label: "X", color: "#e7e9ea" },
  facebook: { label: "Facebook", color: "#1877f2" },
  soundcloud: { label: "SoundCloud", color: "#ff5500" },
  bandcamp: { label: "Bandcamp", color: "#629aa9" },
  twitch: { label: "Twitch", color: "#9146ff" },
  reddit: { label: "Reddit", color: "#ff4500" },
  dailymotion: { label: "Dailymotion", color: "#0066dc" },
  spotify: { label: "Spotify", color: "#1db954" },
  tidal: { label: "Tidal", color: "#00d9ff" },
  qobuz: { label: "Qobuz", color: "#0070d8" },
  apple: { label: "Apple Music", color: "#fa57c1" },
  generic: { label: "Web", color: "#9a9aa8" },
};

function hostOf(url) {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Determine the platform slug from a hostname (e.g. "soundcloud.com" → "soundcloud").
function platformFromHost(host) {
  if (!host) return "generic";
  for (const key of Object.keys(PLATFORM_META)) {
    if (key === "generic") continue;
    if (host.includes(`${key}.com`) || host.includes(`${key}.`)) return key;
  }
  return "generic";
}

/**
 * Classify a pasted URL.
 * @returns {{ type: 'direct'|'match', platform: string, host: string }}
 */
export function detect(url) {
  const raw = String(url || "").trim();
  const host = hostOf(raw);

  // DRM services → metadata-match path.
  for (const [matchHost, platform] of Object.entries(MATCH_HOSTS)) {
    if (host.endsWith(matchHost) || host.includes(matchHost)) {
      return { type: "match", platform, host };
    }
  }

  // Everything else → yt-dlp direct path. Note we deliberately do NOT validate
  // against a known-good list; yt-dlp supports 1000+ sites and we let it decide.
  return { type: "direct", platform: platformFromHost(host), host };
}

export function isValidUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  // Accept anything that looks like a domain or a scheme:// URL.
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/.test(raw);
}
