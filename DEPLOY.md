# grab · Two-Part Deployment Guide

This app is split into two pieces that talk over HTTPS:

```
┌────────────────────────────────────┐         ┌─────────────────────────────────┐
│  Cloudflare Pages (different acct) │         │  CF Tunnel → this VPS           │
│  grab.msedge.lol  · static only    │ ──HTTPS──▶  grab-api.msedge.lol · API    │
│  public/index.html + app.js        │         │  Express on 127.0.0.1:3000      │
└────────────────────────────────────┘         └─────────────────────────────────┘
            ↳ no build step, ships public/ verbatim           ↳ CORS-locked to grab.msedge.lol
```

The backend was already wired up by these changes:

- `server.js` — added `ALLOWED_ORIGINS` CORS middleware before routes.
- `cloudflared config.yml` — `grab.msedge.lol` is gone; only `grab-api.msedge.lol → 127.0.0.1:3000` remains.
- `public/app.js` — every `/api/*` call now uses absolute `https://grab-api.msedge.lol/api/...`.

The frontend half is what this guide covers.

---

## 1 · Authenticate wrangler on this VPS

You'll need either an interactive `wrangler login` (opens a browser) or an API token.

### Option A · API token (preferred for headless VPS)

1. In the **target Cloudflare account** (NOT this `msedge.lol` one) → *My Profile → API Tokens → Create Token*.
2. Use the **"Edit Cloudflare Pages"** template, scope it to the account.
3. Back on the VPS, export it before running wrangler:

```bash
export CLOUDFLARE_API_TOKEN="paste-token-here"
export CLOUDFLARE_ACCOUNT_ID="paste-account-id-here"
```

Both values show up at the right side of the Cloudflare dashboard home for that account.

### Option B · Interactive login (requires browser/SSH tunnel)

```bash
wrangler login
```

It will print a URL — open it in a browser that's logged into the target account and paste the device code back. Won't work on a headless server without an SSH tunnel that forwards X11 or a copy-paste workflow.

---

## 2 · First deploy of `public/`

```bash
cd /root/grab
wrangler pages deploy public --project-name=grab-front
```

On first run wrangler will create the Pages project, give it an auto-assigned hostname like `grab-front.pages.dev`, and upload `public/`.

Verify:

```bash
curl -sI https://grab-front.pages.dev | head -5
```

You should see `HTTP/2 200` and the `X-Content-Type-Options: nosniff` header from `public/_headers`.

---

## 3 · Add `grab.msedge.lol` as a custom domain on the Pages project

In the **target account's CF dashboard**:

1. Workers & Pages → `grab-front` → Custom domains → Set up a custom domain.
2. Enter `grab.msedge.lol`. Cloudflare will:
   - Detect that `msedge.lol` is on a **different** CF account.
   - Show you a **CNAME target** like `grab-front.pages.dev.cdn.cloudflare.net` (or similar).
   - Ask you to add the CNAME on the `msedge.lol` account before it'll validate.

The target hostname **is the value you need to put on the other account's DNS** — see step 4.

*(Note: CNAMEs at the apex of a zone aren't allowed, but `grab.msedge.lol` is a subdomain, so a plain CNAME works fine. No Cloudflare-for-SaaS required.)*

---

## 4 · Wire up DNS in the **msedge.lol** account

### A · Backend tunnel route — `grab-api.msedge.lol`

In the `msedge.lol` Cloudflare dashboard:

1. Zero Trust → Networks → Tunnels → select the existing tunnel (`52f2300a-b906-4231-ad27-60c19cebd0cc`).
2. Public hostname tab → Add a public hostname:
   - Subdomain: `grab-api`
   - Domain: `msedge.lol`
   - Service: `http://127.0.0.1:3000`
3. Save. Cloudflare auto-creates a CNAME for `grab-api.msedge.lol` pointing at `<tunnel-id>.cfargotunnel.com` in the `msedge.lol` zone (since the zone is on the same account, this is automatic).

### B · Frontend Pages domain — `grab.msedge.lol`

In the `msedge.lol` Cloudflare dashboard → DNS → Records:

1. Add a CNAME record:
   - Name: `grab`
   - Target: the value Cloudflare gave you in step 3 (e.g. `grab-front.pages.dev.cdn.cloudflare.net`)
   - Proxy status: **Proxied** (orange cloud)
2. Save.

Wait ~60s for DNS to propagate. Verify:

```bash
getent hosts grab.msedge.lol
getent hosts grab-api.msedge.lol
curl -sI https://grab.msedge.lol | head -3
curl -sI https://grab-api.msedge.lol/api/info?url=test | head -3
```

---

## 5 · Apply CORS lock on the backend

Already done in `server.js` — origin list:

```js
const ALLOWED_ORIGINS = [
  "https://grab.msedge.lol",
  "http://localhost:3000",     // local dev
  "http://127.0.0.1:3000",     // local dev
];
```

If you ever add a preview/staging domain, append it here and restart the Node process.

---

## 6 · Re-deploy loop

Whenever you change `public/*`:

```bash
cd /root/grab
wrangler pages deploy public --project-name=grab-front
```

Cache-busts: `index.html` is `Cache-Control: max-age=0`, so it's always fresh. `app.js` has `?v=N` bumps in `<script src>` to force invalidation.

Whenever you change `server.js`:

```bash
pm2 restart grab-server
```

---

## 7 · Quick troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `grab.msedge.lol` 404 | CNAME not added in msedge.lol zone | step 4B |
| `grab-api.msedge.lol` won't connect | Tunnel public hostname missing | step 4A |
| Browser console: CORS error | `grab.msedge.lol` not in `ALLOWED_ORIGINS` | step 5 |
| Browser: `Unexpected token '<'` | Tunnel 502 → HTML error page | check `journalctl -u cloudflared` or `/tmp/cloudflared.log` |
| Old UI shows after deploy | Hard-refresh (Ctrl+Shift+R) or wait for cache-bust | bump `?v=N` in `index.html`'s `<script src>` |

---

That's it. Two pieces, one URL, no 502 timeouts because the static half never hits the tunnel on the hot path.
