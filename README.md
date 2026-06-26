# Grab

A fast, polished **multi-source media downloader** — paste a link, pick a format, grab it. Built as a split-architecture web app: a vanilla JS frontend on Cloudflare Pages + a Node.js/Express backend on a VPS behind Cloudflare Tunnel.

## Architecture

```
┌──────────────────────────────────────┐         ┌───────────────────────────────────┐
│  Cloudflare Pages                    │         │  CF Tunnel → VPS (this repo)       │
│  grab.msedge.lol  ·  static only     │ ──HTTPS──▶  grab-api.msedge.lol  ·  API      │
│  public/index.html + app.js + boids  │         │  Express on 127.0.0.1:3000         │
└──────────────────────────────────────┘         └───────────────────────────────────┘
             ↳ No build step                          ↳ CORS-locked to grab.msedge.lol
             ↳ Cache-busted via ?v=N                  ↳ PM2-managed, auto-restart
```

The frontend is pure HTML/CSS/JS — no frameworks, no build step. The backend uses yt-dlp + ffmpeg for downloads, better-sqlite3 for caching, sharp for palette extraction, express-rate-limit for abuse prevention, and PM2 for process management.

## What it can download

### Direct sources (full quality via yt-dlp — 1000+ sites)
**YouTube** (video, audio, playlists → ZIP), **Vimeo**, **Dailymotion**, **Twitch**, **Reddit**, **Instagram**, **TikTok**, **X/Twitter**, **Facebook**, **SoundCloud**, **Bandcamp**, **YouTube Music**, and hundreds more.

### Match sources (DRM services → metadata-matched YouTube audio, ID3-tagged)
**Spotify**, **Apple Music**, **Tidal**, **Qobuz**. These services use DRM, so playable audio can't be pulled directly. Instead, public metadata is read, the best YouTube match is found (by ISRC or artist+title), that audio is downloaded, and ID3 tags + album art are embedded — same approach as spotDL.

> **Limitation:** Match quality depends on YouTube availability. Rare tracks may not be found. Audio quality is YouTube's, not the streaming service's native quality.

## Quick Start

**Prerequisites:** Node.js 18+, [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ffmpeg](https://ffmpeg.org/)

```bash
npm install
cp .env.example .env   # edit with your values
npm start              # http://localhost:3000
```

For development with live reload:
```bash
npm run dev
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express server port |
| `YT_DLP` | `yt-dlp` | Path to yt-dlp binary |
| `YT_DLP_JS_RUNTIME` | `node` | JS runtime for yt-dlp's EJS challenge solver (Node v22+, Deno) |
| `FFMPEG_LOCATION` | auto-detected | Directory containing ffmpeg binary |
| `COOKIES_FILE` | `./cookies.txt` | Netscape-format cookies for auth-gated sites (Instagram/TikTok) |
| `SPOTIFY_CLIENT_ID` | — | Spotify Web API client ID (optional, for albums/playlists) |
| `SPOTIFY_CLIENT_SECRET` | — | Spotify Web API client secret |
| `CLOUDFLARE_API_TOKEN` | — | CF API token with Pages:Edit scope (for `wrangler pages deploy`) |
| `CLOUDFLARE_ACCOUNT_ID` | — | CF Account ID for Pages deployment |

## Project Structure

```
grab/
├── server.js                  # Express app: CORS, routes, rate-limit, graceful shutdown
├── ecosystem.config.cjs       # PM2 process config (auto-restart, log rotation, memory limits)
├── wrangler.toml              # Cloudflare Pages deployment config
├── package.json               # Dependencies & scripts
├── .env.example               # Template for environment variables
├── .gitignore                 # Ignores node_modules, downloads, data, .env, logs
│
├── lib/
│   ├── detect.js              # URL classifier (direct vs match), platform detection
│   ├── ytdlp.js               # yt-dlp wrapper: info extraction, format grouping, downloads
│   ├── cache.js               # SQLite-backed URL response cache (better-sqlite3, WAL mode)
│   ├── search.js              # YouTube Music search by ISRC or artist+title
│   ├── archive.js             # Batch download → ZIP archive on disk
│   ├── tagging.js             # ID3 tag embedding (title, artist, album, artwork)
│   └── matchers/
│       ├── index.js           # Routes match sources to platform-specific resolvers
│       ├── spotify.js         # Spotify Web API + oEmbed fallback
│       ├── appleMusic.js      # iTunes Lookup API
│       ├── tidal.js           # Tidal API + Deezer search fallback
│       └── qobuz.js           # Qobuz API + Deezer search fallback
│
└── public/
    ├── index.html             # Full app: Flexoki theming, glassmorphism, custom dropdowns, responsive
    ├── app.js                 # Frontend logic: search, format selects, progress ring, SSE, palette
    ├── boids.js               # Full-screen Reynolds flocking animation with palette theming
    └── _headers               # Cloudflare Pages edge caching rules
```

## How It Works

### Two download paths

1. **Direct** (yt-dlp sites): URL → metadata + format list → pick format → background download → SSE progress → stream file → delete from disk
2. **Match** (DRM services): URL → read public metadata → find best YouTube match → download audio → embed ID3 tags/artwork → SSE progress → stream file

### API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/info?url=` | GET | Auto-detect source, resolve metadata + formats or matched tracks |
| `/api/prepare` | POST | Stash download job (single/batch), return short-lived token |
| `/api/download` | POST | Trigger background download, return immediately |
| `/api/progress/:token` | GET | SSE stream for real-time download progress |
| `/api/file/:id` | GET | Serve completed download file (temporary, auto-expires) |
| `/api/health` | GET | Health check (uptime, memory) |

### Key design decisions

- **Split architecture** — static frontend on CF Pages (fast global edge), API on VPS (compute-heavy). No CORS issues, no 502 timeouts from serving static assets through the tunnel.
- **SQLite cache** — every `/api/info` response is cached permanently in a WAL-mode SQLite DB. Repeat lookups return instantly. Auto-pruned at 50K entries / 100MB.
- **File lifetime** — downloads reside on disk temporarily. Lifetime scales with file size (min 5 min, max 24h). Cleanup job runs every 60s. Disk guard caps total download storage at 2GB.
- **Rate limiting** — 30 req/min for API, 5 req/min for downloads. IP-based, no X-Forwarded-For header trusted (safe behind CF Tunnel).
- **Graceful shutdown** — SIGTERM/SIGINT triggers 5s drain window. uncaughtException forces exit(1) for clean PM2 restart. SQLite DB closes on exit event.
- **PM2** — managed process with 500MB memory limit, 10 max restarts, exponential backoff, log rotation (10MB × 5 files), `@reboot pm2 resurrect` in crontab.

## Frontend Features

- **Flexoki color system** — Steph Ango's inky palette with dark/light theme toggle, persisted to localStorage
- **Adaptive palette extraction** — server extracts accent/background/surface colors from thumbnails via sharp; frontend applies full themed UI (backgrounds, text, glass cards, dropdowns)
- **Custom themed dropdowns** — native `<select>` elements replaced with glassmorphism dropdowns, portal'd to body, keyboard-navigable, MutationObserver-synced
- **Boids background** — full-screen Reynolds flocking animation, palette-themed, responsive (40 boids mobile, 90 desktop), cursor parallax, card avoidance, event-triggered burst/expand
- **Progress ring** — SVG circular progress with SSE streaming, speed/ETA display, checkmark on completion
- **Multi-item** — playlist/album support with checkboxes, select-all, batch ZIP download with progress
- **Responsive** — mobile-first: 44px touch targets, safe-area insets, 16px inputs (no iOS zoom), `@media (hover: hover)` guards

## Deployment

### Frontend (Cloudflare Pages)
```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
cd /root/grab
wrangler pages deploy public --project-name=grab-front
```
Cache-bust: bump `?v=N` on `<script src>` in `index.html`.

### Backend (VPS)
```bash
pm2 start ecosystem.config.cjs
pm2 save                          # persist across reboots
crontab -e                         # add: @reboot pm2 resurrect
```

### Cloudflare Tunnel
```bash
cloudflared tunnel run <tunnel-name> &
```
Public hostname `grab-api.msedge.lol` → `http://127.0.0.1:3000`.

### Full setup guide
See `DEPLOY.md` for step-by-step cross-account CF Pages custom domain setup and `WRANGLER-AUTH.md` for API token creation.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Page reloads to `/?` | JS syntax error or form submits via GET | Check browser console for errors; `onsubmit="return false"` guards at HTML level |
| 502 on API | Tunnel disconnected or Node crashed | `pm2 status`, `cloudflared tunnel info <name>`, check `/tmp/cloudflared.log` |
| CORS error in browser | Origin not in ALLOWED_ORIGINS | Add domain to `server.js` ALLOWED_ORIGINS, restart |
| Downloads fail with ffmpeg error | ffmpeg not found | Set `FFMPEG_LOCATION` env var or install ffmpeg |
| Old UI after deploy | Cached app.js (immutable header) | Hard-refresh (Ctrl+Shift+R) or bump `?v=N` |
| yt-dlp fails on YouTube | Missing JS runtime | Ensure Node v22+ or set `YT_DLP_JS_RUNTIME=node` |
| Instagram/TikTok blocked | Auth required | Place `cookies.txt` (Netscape format) in project root |

## License & Disclaimer

**Personal use only.** Respect creators and each platform's Terms of Service. This tool does not host, store, or distribute copyrighted content — it's a local download manager that wraps yt-dlp and ffmpeg.
