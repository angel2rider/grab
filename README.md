# grab

A fast, polished **multi-source** media downloader that runs locally. Paste a link from almost anywhere — video platforms, social media, or streaming services — pick a format, grab it.

Built with Node.js + Express wrapping [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and `ffmpeg`. No database, no cloud — nothing is stored after you download.

## What it can grab

### Direct sources (full quality, native streams via yt-dlp)

Any site yt-dlp supports — that's 1000+ platforms:

- **YouTube** — videos, playlists (→ ZIP), audio extraction
- **Vimeo**, **Dailymotion**, **Twitch**, **Reddit**
- **Instagram**, **TikTok**, **X/Twitter**, **Facebook** *(some require cookies — see Notes)*
- **SoundCloud**, **Bandcamp**, **YouTube Music**
- …and many more. Just paste the URL.

### Match sources (metadata → YouTube audio, tagged)

Streaming services use DRM, so playable audio can't be pulled from them directly. Instead, this app reads the track's public metadata, finds the best match on YouTube, downloads that audio, and tags it with the original metadata (title, artist, album, artwork) — the same approach [spotDL](https://github.com/spotDL/spotify-downloader) uses.

- **Spotify** — tracks work out of the box (oEmbed). Albums/playlists need API credentials (below).
- **Apple Music** — songs resolve via the iTunes Lookup API (no auth needed).
- **Tidal** / **Qobuz** — tracks with a name in the URL resolve via Deezer's search API.

> **Honest limitation:** match quality depends on YouTube availability. Rare or region-locked tracks may not be found. Matched audio is YouTube quality, not the streaming service's native quality.

## Prerequisites

You need these installed and on your `PATH`:

- **Node.js** 18+ (tested on v26)
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — `brew install yt-dlp`
- **[ffmpeg](https://ffmpeg.org/)** — `brew install ffmpeg`

## Run

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

Configuration via environment variables:

```bash
PORT=8080 \
YT_DLP=/usr/local/bin/yt-dlp \
FFMPEG_LOCATION=/opt/homebrew/bin \
npm start
```

For live reload during development:

```bash
npm run dev
```

### Optional: Spotify albums & playlists

Single Spotify tracks work with no setup. To resolve full albums and playlists, create a free app at [developer.spotify.com](https://developer.spotify.com/dashboard) and set:

```bash
SPOTIFY_CLIENT_ID=your_id \
SPOTIFY_CLIENT_SECRET=your_secret \
npm start
```

## How it works

### Two download paths

1. **Direct** (yt-dlp sites): URL → metadata → pick format → download → stream.
2. **Match** (DRM services): URL → read public metadata → find YouTube match → download audio → embed original tags/artwork → stream.

### Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/info?url=` | GET | Auto-detects the source, resolves metadata + formats or matched tracks |
| `/api/prepare` | POST | Stashes a download job (single or batch), returns a short-lived token |
| `/api/download?token=` | GET | Streams a single file or a ZIP archive to the browser, then cleans up |

- All downloads are staged in the OS temp dir and **deleted immediately** after streaming — nothing is retained.
- Download tokens expire after 10 minutes and are single-use.
- **Playlists/albums/batches** download every selected item and deliver as a single `.zip`.
- Matched MP3s are tagged with the original service's metadata (title, artist, album, album art) via ID3.

## Project layout

```
.
├── server.js              # Express app: route router + endpoints
├── package.json
├── lib/
│   ├── detect.js          # URL → { type: direct|match, platform }
│   ├── ytdlp.js           # yt-dlp wrappers (info, list, downloadOne, stream)
│   ├── archive.js         # batch download → ZIP stream
│   ├── search.js          # find best YouTube match by ISRC / artist - title
│   ├── tagging.js         # node-id3 wrapper (embed metadata + art)
│   └── matchers/
│       ├── index.js       # routes match sources to resolvers
│       ├── spotify.js     # Spotify Web API + oEmbed fallback
│       ├── appleMusic.js  # iTunes Lookup API
│       ├── tidal.js       # slug + Deezer search
│       └── qobuz.js       # slug + Deezer search
└── public/
    ├── index.html         # Dark, glassy UI (source badges, multi-item list)
    └── app.js             # Frontend logic (no framework)
```

## Notes & limitations

- **Personal use only.** Respect creators and each platform's Terms of Service.
- **Auth-gated content** (Instagram/TikTok/private videos) may require cookies. Pass a cookies file to yt-dlp manually; cookie handling isn't built into the UI.
- **Match sources deliver YouTube audio**, tagged with the original metadata — not the streaming service's native stream (those are DRM-protected).
- **Tidal/Qobuz** pages are fully JS-rendered with no server-side metadata, so only track URLs that contain a name slug can be resolved.
- **Large/4K muxed downloads** take time server-side before the first byte (yt-dlp must download + remux). Browser download progress appears once streaming begins.
- If downloads fail with ffmpeg errors, set `FFMPEG_LOCATION` to the directory containing your `ffmpeg` binary.
```
