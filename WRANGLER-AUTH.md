# grab · wrangler authentication (API-token path)

This guide is for the **target** Cloudflare account (the one `grab-front` Pages will live on — **NOT** the `msedge.lol` account). You can do everything from a browser and a `ssh root@<vps>` connection.

---

## Why API-token instead of `wrangler login`

`wrangler login` opens your default browser, prints a one-time URL, you visit it, log into the target account, copy a code, paste it back. **It does not work on a headless VPS** — there's no browser, no DISPLAY, no clipboard path unless you've set up X-forwarding over SSH.

The API-token path is fully scripted and survives ssh-only access.

---

## 1 · Create the API token in the **target** account

1. Open **the target account's dashboard** (the one your new Pages project will belong to) in a browser.
2. Click your **profile avatar (top right) → My Profile → API Tokens**.
3. Click **Create Token**.
4. Pick the **"Edit Cloudflare Pages"** template (this exact template exists in the dashboard).
   - If you can't find it, click **"Create Custom Token"** and set these permissions yourself:

| Scope | Permission | Notes |
|---|---|---|
| Account → Cloudflare Pages | **Edit** | Lets wrangler create + deploy the project |
| Account → Account Settings | **Read** | Lets wrangler look up the account scope of your token |
| Zone → Zone | **Read** *(optional)* | Only needed if you'll use the token to manage zones in the same account. Pages alone doesn't need it. |

5. **Account Resources**:
   - Account: select **the target account** (the one your Pages project will live in)
6. **TTL / expiry**: pick something finite for hygiene (e.g. 30 days). You can always re-issue.
7. Click **Continue to summary → Create Token**.
8. Cloudflare shows the token **once**. Copy it now — you can't see it again.

It looks like: `aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3a`

---

## 2 · Find your Account ID

The **Account ID** of the target account is shown on the dashboard home (right-hand sidebar after you log in):

```
Example: 1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p
```

Or via the API (also works with the new token):

```bash
# from anywhere — substitute the token you just made
curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.cloudflare.com/client/v4/accounts \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print([a["id"] for a in d["result"]])'
```

You only need **one** Account ID — the target account's.

---

## 3 · Apply on the VPS

Add to `~/.bashrc` (or `~/.profile`), or `export` inline before each `wrangler` call:

```bash
export CLOUDFLARE_API_TOKEN="paste-your-token-here"
export CLOUDFLARE_ACCOUNT_ID="paste-your-account-id-here"
```

To make it stick across ssh sessions:

```bash
cat >> ~/.bashrc <<'EOF'

# grab · CF deploy credentials
export CLOUDFLARE_API_TOKEN="paste-token-here"
export CLOUDFLARE_ACCOUNT_ID="paste-account-id-here"
EOF
source ~/.bashrc
```

For non-interactive bash sessions (cron jobs, systemd timers, scripts), put the same exports in `~/.bash_profile` or `~/.profile` — `.bashrc` is NOT sourced by non-interactive bash by default:

```bash
grep -q CLOUDFLARE_API_TOKEN ~/.bash_profile 2>/dev/null || cat >> ~/.bash_profile <<'EOF'

# grab · CF deploy credentials (sourced by login shells)
export CLOUDFLARE_API_TOKEN="paste-token-here"
export CLOUDFLARE_ACCOUNT_ID="paste-account-id-here"
EOF
```

> ⚠️ The token grants Pages edit rights on the **target** account. Don't commit it anywhere. Don't put it in `wrangler.toml`.

---

## 4 · Verify the token works

A healthy answer prints your account name + ID:

```bash
wrangler whoami
```

Output (the exact format varies by wrangler version — look for the `cloudflare_pages · edit` line):

```
⛅️ wrangler <version>
───────────────────
Getting User settings...
👋 You are logged in.
Account ID: <your-account-id>
Account Name: <your-account-name>
  ...
Token scope: object · read · account · ... · cloudflare_pages · edit
```

The key thing to confirm is `cloudflare_pages · edit` is in the Token scope list.

`cloudflare_pages · edit` confirms the token has the permission for `wrangler pages deploy`.

---

## 5 · Deploy the frontend

The project is **`grab-front`**, build output is **`public/`**, no build step:

```bash
cd /root/grab
wrangler pages deploy public --project-name=grab-front
```

First run will:
- Create the `grab-front` Pages project on the target account
- Assign it `<random>.grab-front.pages.dev` — wrangler prints the **exact URL** once at the end of the deploy output. Copy that one, don't invent one.
- Upload everything in `./public/`
- Print `✨ Deployment complete! Take a peek: …`

Verify the upload landed — substitute wrangler's actual printed URL:

```bash
PAGES_URL="<paste-the-exact-url-wrangler-printed>"
curl -sI "$PAGES_URL" | head -3
# expect HTTP/2 200 with the headers from public/_headers
```
```bash
# Confirm CF applied the edge security headers from public/_headers
curl -sI "$PAGES_URL" | grep -iE 'x-content-type|x-frame'
```
```bash
# app.js is marked immutable for 1 year
curl -sI "$PAGES_URL/app.js" | grep -i cache-control
```
```bash
# index.html is always fresh (so cache-bust ?v=N always works)
curl -sI "$PAGES_URL/index.html" | grep -i cache-control
```

---

## 6 · Add `grab.msedge.lol` as a custom domain on the Pages project

This is a **manual** step in the target account's dashboard (Cloudflare can't auto-wire cross-account custom domains):

1. **Target account dashboard** → **Workers & Pages** → click `grab-front` → **Custom domains** tab.
2. Click **Set up a custom domain**.
3. Enter `grab.msedge.lol`.
4. Cloudflare detects the **cross-account scenario** (`msedge.lol` is on a different CF account) and tells you to manually add a CNAME on the **other account's** DNS.
5. It will give you a **CNAME target** like:

   ```
   grab-front.pages.dev.cdn.cloudflare.net
   ```
   (or similar — copy it exactly).

6. **Don't** click **Activate** yet — go do step 7 first.

---

## 7 · Add the CNAME in the **msedge.lol** Cloudflare DNS

**`msedge.lol` account dashboard** → **DNS** → **Records** → **Add record**:

| Field | Value |
|---|---|
| Type | **CNAME** |
| Name | `grab` |
| Target | the value from step 6 (e.g. `grab-front.pages.dev.cdn.cloudflare.net`) |
| Proxy status | **Proxied** (orange cloud — that's the whole point of doing it in CF) |

Save. Wait ~60s for DNS propagation.

Verify:

```bash
getent hosts grab.msedge.lol
# expect: ::1 or Cloudflare-prefixed address

curl -sI https://grab.msedge.lol
# expect: HTTP/2 200, X-Content-Type-Options: nosniff
```

### Cross-account custom-domain activation checklist

Don't activate the custom domain in step 6 until **all four** of these are true — Cloudflare's cross-account CNAME validation will not pass otherwise:

- [ ] Pages project's `grab.msedge.lol` showing in the Custom Domains tab on the **target** account (step 6).
- [ ] CNAME record `grab → <pages-target>.pages.dev.cdn.cloudflare.net` exists in the **msedge.lol** zone (step 7).
- [ ] The CNAME's proxy status is **Proxied** (orange cloud) — DNS-only/grey-cloud won't validate via this path.
- [ ] ≥60s elapsed since the CNAME was saved (propagation).

When all four check out, the custom-domain status will flip from "pending" to "active" — sometimes before you click anything (it auto-validates), sometimes only after you click **Activate**. Both are fine.

---

## 8 · End-to-end smoke test

After DNS propagates:

```bash
# 1. Frontend serves HTML
curl -s https://grab.msedge.lol | grep -c '<title>Grab'

# 2. Frontend -> backend via CORS works
curl -is -H 'Origin: https://grab.msedge.lol' \
  https://grab-api.msedge.lol/api/info?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ
# expect: Vary: Origin + Access-Control-Allow-Origin: https://grab.msedge.lol + Content-Type: application/json

# 3. Backend is up locally
curl -sI http://127.0.0.1:3000
```

Open `https://grab.msedge.lol` in your browser — should load instantly because the static half never hits the tunnel. Paste a YouTube link, hit Grab, watch the progress bar (it crosses origins to `grab-api.msedge.lol` via `fetch` and `EventSource`).

---

## 9 · Re-deploying after edits

For backend (`server.js`, `lib/*`):

```bash
fuser -k 3000/tcp 2>/dev/null; sleep 2
cd /root/grab && node server.js > /tmp/grab-server.log 2>&1 & disown
```

For frontend (`public/*`):

```bash
cd /root/grab
wrangler pages deploy public --project-name=grab-front
```

To force a hard-refresh in the browser after a frontend deploy, bump `?v=N` on the `<script src="app.js?v=N">` line in `public/index.html` so browsers stop serving the immutable cached copy from `public/_headers`.

---

## 10 · Token rotation / troubleshooting

| Symptom | Where it appears | Most likely cause | Fix |
|---|---|---|---|
| `wrangler whoami` → "Authentication error [code: 10000]" | VPS CLI | Token revoked, expired, or scope wrong | Re-issue the token at step 1 with `Cloudflare Pages: Edit` scope; confirm Account Resources targets the **target** account (not `msedge.lol`) |
| `wrangler whoami` → "Authentication error [code: 10001]" | VPS CLI | Token's IP allowlist excludes the VPS | Edit the token and either remove the IP allowlist or add the VPS's egress IP |
| `Error: "Pages": "edit" permission is required"` | `wrangler pages deploy` step 5 | Token is missing the Pages scope | Re-edit the token and add `Account → Cloudflare Pages: Edit` |
| Custom-domain "DNS validation failed" in target account | Pages dashboard, step 6/7 | CNAME target mismatch or proxy status wrong | Confirm CNAME `grab → <pages-target>.pages.dev.cdn.cloudflare.net` exists with orange cloud on the `msedge.lol` zone; wait 60s |
| **CORS error in browser console** | Browser dev tools | Backend isn't echoing the origin | Confirm `ALLOWED_ORIGINS` in `server.js` contains `https://grab.msedge.lol` and the server was restarted with that change |
| **`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`** in `fetch().json()` | Browser console | Server returned an HTML error page (502/504) where JSON was expected — almost always a tunnel hiccup. The frontend will already show a clean "Server error (502). Please try again." thanks to the safe parse in `app.js` — if you see a raw "Unexpected token" then you're on an older build. Bump `?v=N` on the script tag and hard-refresh | Confirm `grab-api.msedge.lol` is reachable: `curl -sI https://grab-api.msedge.lol`; if it's down, `cloudflared tunnel info gameap-nyc-01` and restart cloudflared if the connector isn't `HEALTHY` |
| **502 Bad Gateway** on `grab-api.msedge.lol` (or undefined in browser) | curl / browser | Tunnel connector lost its long-lived QUIC/TCP connection, or the VPS-side `node server.js` died | `pgrep -af cloudflared` (must have a process); if not, `pkill -9 cloudflared; cloudflared tunnel --config /root/.cloudflared/config.yml run > /tmp/cloudflared.log 2>&1 & disown`. Also `curl -sI http://127.0.0.1:3000` to confirm `node server.js` is alive on the VPS |
| **SSL handshake error on `grab.msedge.lol`** | Browser | On the split architecture, the frontend is served natively by CF edge with auto-issued certs. If TLS still fails, the custom-domain almost certainly isn't activated yet | Confirm the CNAME in step 7 is in place AND orange-cloud AND ≥60s propagation elapsed; then re-attempt activation in step 6. If it was previously active and just stopped, re-check the CNAME target hasn't been changed by accident |
| Old UI after frontend deploy | Browser static assets | `app.js` has `max-age=31536000, immutable` (see `public/_headers`) and the browser cached the prior version | Bump the `?v=N` query string on the `<script src>` line in `public/index.html` and re-deploy. Or hard-refresh with cache disabled (Ctrl+Shift+R) |

That's it — once both halves resolve (the static grab.msedge.lol and the tunnel fetch of grab-api.msedge.lol), the site is fully split.
