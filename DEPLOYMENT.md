# OpenSign Deployment — `docsign.betterid.net`

**Status:** ✅ Live (moved from `docsign.bettersign.ing` on 2026-11-22) · **Deployed:** 2026-10-06 · **Owner:** brendon@ixiomsoftware.com

A self-hosted [OpenSign](https://github.com/OpenSignLabs/OpenSign) (open-source DocuSign
alternative) running as a split frontend/backend across **Cloudflare** and **Fly.io**.

---

## 1. Live endpoints

| Piece | URL | Platform |
|---|---|---|
| **Frontend (app UI) — canonical** | https://docsign.betterid.net | Cloudflare Workers (Static Assets) |
| ↳ old name | https://docsign.bettersign.ing → **301 redirects** to docsign.betterid.net, same path and query (`deploy/cloudflare-frontend/redirect.js` in the Worker) | Cloudflare |
| ↳ alias | https://opensign.bettersign.ing → **301 redirects** to docsign (Page Rule) | Cloudflare |
| **Backend API** (Parse Server) | https://docsign-bettersign-api.fly.dev | Fly.io (Docker) |
| **Database** (MongoDB) | `docsign-bettersign-mongo.internal:27017` (private, no public IP) | Fly.io (Docker) |
| **BetterID relay** ("Sign on phone") | https://relay.betterid.net (BetterSignApps `server/bs-fill-relay`) | Cloudflare Worker + Durable Object |

> **docsign.betterid.net is the single canonical URL.** bs-id's `bs-opensign` client
> only redirects back to it, so Sign in with BetterID only works from that origin —
> `docsign.bettersign.ing` and `opensign.bettersign.ing` 301-redirect to it so every
> entry point lands on the working domain.

### Moving to docsign.betterid.net (BetterSign → BetterID rename)

**Done 2026-11-22** (bs-id version `bfccac88`, BetterSignApps PR #498; docsign
Worker version `90d95a4a`). The site was `docsign.bettersign.ing`. The code defaults to
`https://docsign.betterid.net` (`BS_API_ORIGIN`, email logo, published-certificate
links). The move went in this order, which still applies to a fresh setup:

1. **DNS/zone:** `betterid.net` must be a zone in the Cloudflare account, so the
   Worker can claim `docsign.betterid.net` as a custom domain.
2. **bs-id:** add `https://docsign.betterid.net/auth/bettersign/callback` to the
   `bs-opensign` client's redirect URIs (keep the old one until the move is done) and
   deploy bs-id by hand. Without it, Sign in with BetterID fails on the new name.
3. **Backend** (§7): `fly deploy`. If `BS_API_ORIGIN` or `EMAIL_LOGO_URL` are set as
   Fly secrets, change them to the new name too (`fly secrets list`).
4. **Frontend** (§7): deploy; both names now serve the app.
5. **Redirect:** the Worker itself 301s `docsign.bettersign.ing` to the new name
   (`redirect.js`, `run_worker_first`), because the wrangler login has no zone
   permissions for Redirect Rules. The `opensign.bettersign.ing` Page Rule still
   points at the old name, so it reaches the new one in two hops; repoint it in
   the dashboard when convenient. Extension sign-in and phone signing check the
   origin, so they only work on the new name.
6. **Website links:** `www.betterid.net` (home, privacy, terms) already serves
   BetterID, so `WEBSITE_URL`, `TERMS_URL` and the footer and header links point there.
7. **Service hosts and mail** (code changed 2026-11-22, **deploy only when all are
   live**): the defaults now name `https://id.betterid.net` (`BS_ID_URL` in
   `fly.toml`, `REACT_APP_BS_ID_URL`, the sign-in button), `https://relay.betterid.net`
   (`BS_RELAY_URL`), `https://verify.betterid.net` (`BS_VERIFIER_URL`) and
   `contact@betterid.net` (`SUPPORT_EMAIL`, footer, all seven languages). Before
   deploying them (all checked 2026-11-23):
   - ✅ `id.betterid.net` serves bs-id (issuer `https://id.betterid.net`; the `iss`
     check uses `BS_ID_URL`). The browser extension trusts it from 0.0.8
     (BetterSignApps `client/browserExtension/shared/src/background/config.ts`,
     `PRODUCTION_IDP_ORIGINS`, which still lists `id.bettersign.ing` too).
   - ✅ `relay.betterid.net` and `verify.betterid.net` answer like the old hosts
     (verifier `GET /health` 200; relay `POST /v1/req` 401 without auth). The relay
     signs its auth message over its own host and accepts `relay.betterid.net`.
   - ✅ Mail to and from `contact@betterid.net` works.
   - ✅ Sending: `SMTP_USER_EMAIL` is `no-reply@send.betterid.net` (Fly secret; it,
     not the code, picks the sender). `send.betterid.net` has the same Resend DKIM,
     SPF and bounce MX records as the old domain.
   - Fly app names keep `bettersign`; they're internal.

Health checks:
- `curl https://docsign.betterid.net/` → app shell (HTTP 200)
- `curl https://docsign-bettersign-api.fly.dev/` → `opensign-server is running !!!`
- `curl https://docsign-bettersign-api.fly.dev/app/health` → `{"status":"ok"}`

---

## 2. Architecture

```
                  Browser
                     │  HTTPS
                     ▼
   ┌─────────────────────────────────────────┐
   │ Cloudflare Workers Static Assets         │   docsign.betterid.net
   │  - React SPA (Vite build, ./build)       │   (Cloudflare universal TLS,
   │  - not_found_handling = SPA              │    global edge cache)
   │  - Worker name: docsign                  │
   └─────────────────────────────────────────┘
                     │  API calls (CORS, cross-origin)
                     │  baked-in URL: .../app
                     ▼
   ┌─────────────────────────────────────────┐
   │ Fly.io app: docsign-bettersign-api       │   *.fly.dev TLS (auto)
   │  - Parse Server 8 (Node 22, Express 5)   │   region: sjc
   │  - LibreOffice (docx→pdf), pdf-lib, etc. │   1 machine, 1 GB RAM
   │  - Local file storage on Fly volume      │   auto_stop = off (always on)
   └─────────────────────────────────────────┘
                     │  Mongo wire protocol
                     │  over Fly private 6PN (IPv6)
                     ▼
   ┌─────────────────────────────────────────┐
   │ Fly.io app: docsign-bettersign-mongo     │   private only (no public IP)
   │  - MongoDB 7, --auth, --ipv6             │   region: sjc
   │  - Persistent volume /data/db (1 GB)     │   512 MB RAM
   └─────────────────────────────────────────┘
```

**Why the frontend talks to `*.fly.dev` directly (not a branded API subdomain):**
Fly auto-provisions valid TLS for `*.fly.dev`. A branded two-level host like
`api.docsign.betterid.net` is **not** covered by Cloudflare's universal cert
(`*.betterid.net` only covers one label deep), which would need Advanced Certificate
Manager or a Fly custom-domain cert. For a test this adds failure points with no
functional benefit. The backend sends open CORS (`Access-Control-Allow-Origin: *`), so the
cross-origin call from `docsign.betterid.net` → `docsign-bettersign-api.fly.dev` works.
See §7 for how to move to a branded API host later.

---

## 3. Key decisions & rationale

| Decision | Why |
|---|---|
| **Frontend on Cloudflare, backend on Fly** (not all-Cloudflare) | OpenSign's backend is a stateful **Parse Server** (Node + MongoDB) that does PDF generation and cryptographic signing itself. It is **not** a thin proxy to a third-party signature API, so it cannot run in a Cloudflare Worker (V8 isolate: no Node built-ins, no persistent Mongo socket, 50 ms CPU cap on free). |
| **Not Cloudflare D1 / KV for the database** | D1 is **SQLite** reachable only *inside* a Worker; Parse Server's adapters are **MongoDB** or Postgres. There is no D1/SQLite adapter and no external driver path. D1 also can't *run* the Node server — it's only storage. Volume was never the blocker; **compatibility** was. |
| **Fly.io over Railway / CF Containers** for the backend | Fly runs the existing Dockerfile directly, has **no platform floor** (Railway = $5/mo min; CF Containers needs Workers Paid $5/mo), and is the cheapest always-on option (~$3–6/mo). |
| **MongoDB self-hosted on Fly** (not MongoDB Atlas M0) | Keeps everything inside one Fly org/private network with the credentials already available; no extra third-party account needed. Atlas M0 (free) remains a drop-in alternative to shave ~$3/mo — see §7. |
| **Cloudflare Workers Static Assets** (not legacy Pages) | The `cf` CLI only supports the current model (`cf deploy`), which is Pages' successor. Same free tier, same global edge, plus SPA routing via `not_found_handling`. |
| **Local file storage (`USE_LOCAL=TRUE`) on a Fly volume** | No S3/R2 credentials needed to get running. Documents persist on the `opensign_files` volume. Trade-off and the R2 upgrade path in §6/§7. |
| **Email disabled** | OpenSign starts fine without Mailgun/SMTP (`verifyUserEmails:false`). No mail credentials were available. Password-reset / verification / "document ready" emails are **off** until configured (§7). |

---

## 4. Component details

### 4.1 Frontend — Cloudflare Worker `docsign`
- **Source:** `apps/OpenSign` (Vite + React 19, `BrowserRouter`).
- **Build:** `npm run build` → `apps/OpenSign/build/` (static assets, ~34 MB).
- **Build-time env** (`apps/OpenSign/.env`, baked into the bundle):
  - `REACT_APP_SERVERURL=https://docsign-bettersign-api.fly.dev/app`
  - `REACT_APP_APPID=<APP_ID>` (must equal the backend `APP_ID`)
- **Deploy config:** `deploy/cloudflare-frontend/` (`cloudflare.config.ts`, `wrangler.config.ts`, `package.json`).
- **SPA routing:** `assets.notFoundHandling = "single-page-application"` so deep links / refreshes return `index.html` (verified: `/form/abc123` → 200).
- **Custom domains:** `domains: ["docsign.betterid.net", "docsign.bettersign.ing"]` in `cloudflare.config.ts` and `wrangler.jsonc` — both are bound to the same Worker, whose `redirect.js` 301s the old name to the new one (see "Moving to docsign.betterid.net" above); Cloudflare created the DNS records + edge certs automatically. The `*.workers.dev` preview URL is **disabled**. (The baked-in API URL is domain-agnostic and CORS is open, so no rebuild is needed to add frontend domains.)

### 4.2 Backend — Fly app `docsign-bettersign-api`
- **Source:** `apps/OpenSignServer` (Parse Server 8).
- **Image:** `apps/OpenSignServer/Dockerfile` (node:22.14.0 + LibreOffice; ~693 MB).
- **Config:** `apps/OpenSignServer/fly.toml` — region `sjc`, 1× `shared-cpu-1x` / 1 GB, `auto_stop_machines="off"`, `min_machines_running=1`, HTTP health check on `/`.
- **Volume:** `opensign_files` (1 GB) mounted at `/usr/src/app/files` (uploaded documents).
- **Secrets (Fly):** `APP_ID`, `MASTER_KEY`, `MONGODB_URI`, `SERVER_URL`.
- **Non-secret env (fly.toml):** `PARSE_MOUNT=/app` (⚠️ must stay `/app` — `cloudServerUrl` is hardcoded to `localhost:8080/app`), `USE_LOCAL=TRUE`, `PORT=8080`.
- **DB migrations** run automatically on boot (verified: "Successfully run migrations.").

### 4.3 Database — Fly app `docsign-bettersign-mongo`
- **Image:** `mongo:7`, launched as `mongod --bind_ip_all --ipv6 --auth`.
  - ⚠️ `--ipv6` is **required**: Fly's private network (`.internal`) is IPv6-only; without it the backend got `ECONNREFUSED` on `[…]:27017`.
- **Config:** `deploy/fly-mongo/fly.toml` — region `sjc`, 1× `shared-cpu-1x` / 512 MB.
- **Volume:** `mongo_data` (1 GB) at `/data/db`. Daily snapshots, 5-day retention (Fly default).
- **Auth:** root user from `MONGO_INITDB_ROOT_USERNAME/PASSWORD` (Fly secrets). No public IP — only reachable within the Fly org's private network.

---

## 5. Expected costs

Free: Cloudflare Workers Static Assets (frontend) — unlimited bandwidth, 100k Worker
requests/day free; static asset responses don't count against that. **$0/mo.**

Fly.io (billed to the `gtc6244@gmail.com` Fly account), always-on:

| Resource | Spec | ~Monthly |
|---|---|---|
| Backend compute | `shared-cpu-1x`, 1 GB RAM, always on | ~$5.70 |
| Backend volume | 1 GB | ~$0.15 |
| Mongo compute | `shared-cpu-1x`, 512 MB RAM, always on | ~$3.20 |
| Mongo volume | 1 GB | ~$0.15 |
| **Total (Fly)** | | **≈ $9.20/mo** |

Plus metered bandwidth (pennies at test volume). Figures are Fly's pay-as-you-go rates as
of Jan 2026 and drift over time; watch https://fly.io/dashboard for actuals.

**Cost levers** (see §7): enable `auto_stop_machines` on the backend (→ near-$0 when idle,
at the cost of ~10–30 s cold starts) and/or replace the Mongo app with **MongoDB Atlas M0
(free)** to drop to **≈ $5.85/mo**.

---

## 6. Ramifications & limitations (read before real use)

1. **This is a test-grade deployment, not production-hardened.**
2. **Single backend instance, no redundancy.** One machine; if it restarts, there's a brief outage. Parse boot + migrations take ~30 s.
3. **File storage is a single Fly volume.** Uploaded/generated documents live only on `opensign_files` (mounted at `/usr/src/app/files`). The mount shadows the repo's email templates, so the Dockerfile seeds them back at startup (see item 5). Volume snapshots exist (5-day) but there's no off-site backup.
4. **MongoDB is self-managed.** Snapshots are Fly's defaults (daily, 5-day). No point-in-time recovery, no replica set. For anything you care about, add external backups or move to Atlas.
5. **Email: Resend via SMTP — verified & delivering (2026-10-06).** Sending via `smtp.resend.com:465`, user `resend`, from `no-reply@send.betterid.net` (was `send.bettersign.ing` until 2026-11-23; see "Moving to docsign.betterid.net", step 7). The sending subdomain is **verified** in Resend (DKIM+SPF records in Cloudflare DNS). End-to-end test confirmed: OpenSign `sendmailv3` → Resend → **delivered** to `brendonp@ixiomsoftware.com` (a first test to `brendon@ixiomsoftware.com` hard-bounced — that mailbox doesn't exist; the real one has the `p`). The Fly volume shadowed the email templates, so the Dockerfile now **seeds** `files_seed/` → `./files` at startup (non-clobbering); verified present on the volume. No DMARC record was added — consider adding one before high-volume sending.
6. **Document signing certificate is a self-signed DEMO cert.** `PFX_BASE64` / `PASS_PHRASE` are set (CN=`OpenSign Demo Signer`, ~825-day validity, node-forge-verified). Signatures will be cryptographically valid but **not trusted** by Adobe/OS trust stores — replace with a CA-issued (e.g. AATL) cert for anything real. With `SEAL_BACKEND=bs-service-identity` the seal comes from docsign's BetterID identity instead (see "Seal with bs-service-identity" below); its certificate is self-issued too, so Adobe still shows it as untrusted.
7. **Secrets were auto-generated; `MASTER_KEY` was rotated 2026-10-06.** `APP_ID`, `MASTER_KEY`, the Mongo password, and the signing cert/passphrase are saved to `DEPLOYMENT-SECRETS.local.txt` (gitignored, `chmod 600`). The `MASTER_KEY` grants full data access — keep it safe.
8. **Open CORS (`*`) on the backend.** Fine for a test; for production, lock the backend to the known frontend origin.
9. **No rate limiting / WAF** in front of the Fly backend (the frontend benefits from Cloudflare's edge, the API does not — it's hit directly).
10. **`cf` is a beta CLI.** The deploy flow is config-file driven (`cloudflare.config.ts` + `wrangler.config.ts`); quirks are documented in §8.
11. **Document upload "body stream is locked" — root cause was a Parse SDK bug exposed by the split-origin setup (FIXED).** The real cause is a bug in **parse-js 8.6.0** `RESTController.js`: when a `progress` callback is passed to `Parse.File.save()` (OpenSign always does), the SDK calls `response.body.getReader()` (locking the stream) *before* checking `Content-Length`, then — when it reads `Content-Length` as `0` — calls `response.json()` on the now-locked body → `Failed to execute 'json' on 'Response': body stream is locked`. `Content-Length` is **not** readable cross-origin unless exposed, and even when exposed browsers don't reliably surface it, so our **split-origin** deployment (app on `opensign.bettersign.ing`, API on `*.fly.dev`) makes the SDK always take the buggy `length === 0` branch. Same-origin OpenSign (hosted) reads `Content-Length` fine, so it never trips — that's why it's upstream-latent. **Fix:** `apps/OpenSign/patches/parse+8.6.0.patch` (via `patch-package`, wired into `postinstall`) moves `getReader()` into the `length > 0` branch so the `length === 0` path can `response.json()` on an unlocked body. Verified in-browser (repro throws; patched logic returns the file URL) and the live bundle serves the patched chunk. The same bug exists in `ParseFile.download` but OpenSign doesn't use that path, so it's left alone.
12. **Public file uploads are enabled** (`index.js` → `fileUpload.enableForPublic`). OpenSign's frontend saves `Parse.File` objects without a session token and doesn't hydrate `Parse.User.current()`. Parse Server's secure default (`enableForPublic:false`) rejects unauthenticated uploads with code 130; enabling public uploads matches OpenSign's hosted config so anonymous/guest flows work. Trade-off: anyone who can reach the API can POST files to storage. Set the Fly secret `FILE_UPLOAD_PUBLIC=false` to lock it back down.
13. **Sign on phone (BetterID).** A signer who signed in with BetterID can approve a signature or initials field in their BetterID app. The API pushes the request to the app through the BetterID relay (`https://relay.betterid.net`), addressed by the VLAD from their sign-in: straight to the app if it's open, else the relay wakes the phone with FCM. No phone number, no separate Worker. Design and protocol: [docs/BetterIDPhoneSign.md](docs/BetterIDPhoneSign.md).
    - **Server settings (all optional):** `BS_RELAY_URL` (default `https://relay.betterid.net`) and `BS_RELAY_SIGNING_KEY` (docsign's relay key, an Ed25519 seed in hex; unset, one is generated once and kept in `bs_ApiConfig`). The app checks requests against `GET /api/v1/relay-key`.
    - **Replaced:** the phone-number flow through the `bs-opensign-sign` coordinator Worker and `REACT_APP_BS_SIGN_URL`. The frontend no longer reads `REACT_APP_BS_SIGN_URL`; it can be dropped from `apps/OpenSign/.env`. The `betteridlogin` cloud fn and `BS_LOGIN_SECRET` stay for now (`bsidlogin` reuses its `/loginAs` helper).
    - **Needs the phone app:** the BetterID app has to register with the relay and handle the `docsign-sign-request` content type (docs/BetterIDPhoneSign.md §6). Until it does, the button reports that the app hasn't connected.
14. **Sign in with BetterID (bs-id OIDC).** The login page's BetterID sign-in, through bs-id (`https://id.betterid.net`, BetterSignApps `apps/Experiments/bs-id`): the passkey on the phone (QR scan or same device) instead of a push. The browser runs authorization code + PKCE (`apps/OpenSign/src/constant/bsid.js`) and returns to `/auth/bettersign/callback`; the `bsidlogin` cloud fn exchanges the code at bs-id `/token`, verifies the ES256 id_token against `/jwks` (`iss`, `aud`, `nonce`, `exp`) and signs in the account its `vlad` maps to.
    - **Who may sign in:** a VLAD needs an active row in the `bs_Identity` class (master key only) pointing at an existing account. Unknown VLADs are refused, logged as `{"event":"bsidlogin_denied","vlad":…}`, and added to `bs_Identity` turned off with no account. An admin links them on the Users page (BetterID identities), or with the master-key `curl` in [docs/BetterIDAPI.md §3](docs/BetterIDAPI.md#3-linking-a-vlad-to-an-account); it takes effect at once, no redeploy.
    - **bs-id side:** the clients `bs-opensign` (callback `https://docsign.betterid.net/auth/bettersign/callback`) and `bs-opensign-dev` (`http://localhost:3000/...`) must be in bs-id's client registry, deployed with `npx wrangler deploy --env prod` in BetterSignApps.
    - Optional frontend overrides (build-time): `REACT_APP_BS_ID_URL` (default `https://id.betterid.net`), `REACT_APP_BS_ID_CLIENT_ID` (default `bs-opensign`). Server: `BS_ID_URL`, `BS_ID_CLIENT_ID`.
    - **Through the extension (no QR after the first time):** needs the `bs-opensign` clients deployed with `extensionLogin: true` (BetterSignApps `server/bs-id`), and `BS_API_ORIGIN` set to the site's origin as the browser sees it (default `https://docsign.betterid.net`) plus the verifier settings (`BS_VERIFIER_URL`, `BS_VERIFIER_SECRET`). Cloud fns `bsextchallenge` and `bsextlogin`; see BetterIDUpdates.md, "After the first time".
    - **Rate limit off Fly.** Both cloud fns are limited per client IP (`BS_API_AUTH_RATE_PER_MIN`, default 30 a minute), using Fly's `Fly-Client-IP`. Anywhere else they fall back to Parse's `request.ip`, which is Express's `req.ip` under Parse's `trustProxy` setting (`PARSE_SERVER_TRUST_PROXY`, off by default). With it off, that's the address of whatever opened the connection. If you host the server off Fly:
      - **Clients connect directly:** nothing to do. The address is the client's and can't be faked with headers.
      - **Behind a proxy or load balancer:** every request comes from the proxy, so all clients share one limit, and one noisy client can lock everyone out of sign-in. Set `PARSE_SERVER_TRUST_PROXY` to the number of proxies in front of it (usually `1`) or their addresses, so `req.ip` is the client address your proxy added to `X-Forwarded-For`; entries the client sent itself are ignored. Make sure the server only accepts traffic from the proxy.
      - **Don't set it to `true`.** That trusts every `X-Forwarded-For` entry, including ones the client wrote, and the limit can be dodged by sending a new value each time.
      - Check the result: send a few requests with made-up `X-Forwarded-For` values and confirm they're still counted together. Or rate-limit `POST /app/functions/bsextchallenge` and `/app/functions/bsextlogin` at the proxy or a WAF instead.
15. **Published certificates.** The completion certificate lists the signed PDF's digital signatures (read through bs-service-identity's `POST /v1/pdf/signatures`; skipped, and logged as `bscerts_*`, when `BS_SERVICE_IDENTITY_URL`/`_TOKEN` aren't set or it fails). BetterID certificates (with a VLAD) and their roots are stored in `bs_PublishedCert` (migration `20261117120000-create_bs_publishedcert.cjs`) and served publicly at `/api/v1/certs/:sha256(.cer)` and `/api/v1/identities/:vlad/certs`, with the page `https://docsign.betterid.net/certs/<vlad or sha256>`. They expose the signer's certificate name and VLAD to anyone with the link: see [docs/PublishedCertificates.md](docs/PublishedCertificates.md) §6.

---

## 7. Operations runbook

All commands assume the repo root. Secret values live in `DEPLOYMENT-SECRETS.local.txt`.

### Redeploy the frontend after a code change
```bash
# 1. Build the SPA with the baked-in API URL (apps/OpenSign/.env already set)
cd apps/OpenSign && npm run build && cd -

# 2. Deploy the static assets (clean dir avoids cf's Vite auto-detection)
rm -rf /tmp/docsign-site && mkdir -p /tmp/docsign-site
cp -R apps/OpenSign/build /tmp/docsign-site/build
cp deploy/cloudflare-frontend/{cloudflare.config.ts,wrangler.config.ts,package.json} /tmp/docsign-site/
cd /tmp/docsign-site && npm install && cf deploy
```
If `cf deploy` fails with `Cannot find package 'cf'` (its `cf/config` import), deploy
with plain Wrangler and the committed `wrangler.jsonc` instead (Cloudflare account
brendonp@ixiomsoftware.com). Only this path includes `redirect.js`, the old-name 301:
```bash
rm -rf /tmp/docsign-site && mkdir -p /tmp/docsign-site
cp -R apps/OpenSign/build /tmp/docsign-site/build
cp deploy/cloudflare-frontend/{wrangler.jsonc,redirect.js} /tmp/docsign-site/
cd /tmp/docsign-site && npx wrangler deploy
```
`apps/OpenSign/.env` (gitignored) must hold `REACT_APP_APPID=729aeaeb26bf`
and `REACT_APP_SERVERURL=https://docsign-bettersign-api.fly.dev/app` before the build.

### Redeploy / restart the backend
The Fly apps belong to the **gtc6244@gmail.com** Fly account (`fly auth whoami`); other
logins get `Could not find App`.
```bash
cd apps/OpenSignServer && fly deploy --ha=false        # rebuild + roll
fly logs  --app docsign-bettersign-api                 # tail logs
fly status --app docsign-bettersign-api
```

### Rotate or add backend secrets
```bash
fly secrets set KEY=value --app docsign-bettersign-api   # triggers a redeploy
```

### Enable email (example: SMTP)
```bash
fly secrets set SMTP_ENABLE=true SMTP_HOST=... SMTP_PORT=465 \
  SMTP_USER_EMAIL=... SMTP_USERNAME=... SMTP_PASS=... \
  --app docsign-bettersign-api
```
Note: the `files/` email templates are shadowed by the volume mount. To use email,
either move the files mount to a dedicated path (e.g. mount at `/data` and set a custom
`filesSubDirectory`) or copy the templates onto the volume.

### Enable the document signing certificate
```bash
fly secrets set PFX_BASE64="$(base64 -i your-cert.p12)" PASS_PHRASE="..." \
  --app docsign-bettersign-api
```

### Seal with bs-service-identity instead of the PFX
The Fly app `bs-service-identity` (BetterSignApps `server/bs-service-identity`;
its README has its own runbook) is reachable only on the private network, at
`BS_SERVICE_IDENTITY_URL` in `apps/OpenSignServer/fly.toml`. To switch the seal
over (plan: [docs/BsServiceIdentitySealing.md](docs/BsServiceIdentitySealing.md) §5):
```bash
# The service's BS_SERVICE_TOKEN; the first command doesn't redeploy
fly secrets set BS_SERVICE_IDENTITY_TOKEN="..." --stage --app docsign-bettersign-api
# Rollout: seal with the service, fall back to the PFX if it fails
fly secrets set SEAL_BACKEND=bs-service-identity SEAL_FALLBACK=p12 --app docsign-bettersign-api
# Check from the API machine (expects JSON with the service's VLAD)
fly ssh console --app docsign-bettersign-api -C \
  "sh -c 'curl -s -H \"authorization: Bearer \$BS_SERVICE_IDENTITY_TOKEN\" \$BS_SERVICE_IDENTITY_URL/v1/identity'"
# Fallbacks show in the logs as {"event":"seal_fallback",...}
fly logs --app docsign-bettersign-api | grep seal_fallback
# Once there are none: fail instead of falling back
fly secrets unset SEAL_FALLBACK --app docsign-bettersign-api
```
To go back to the PFX: `fly secrets unset SEAL_BACKEND`. Documents already
sealed by the service keep their `Seal` and `.sig`.

### Cut backend cost with scale-to-zero (optional)
In `apps/OpenSignServer/fly.toml` set `auto_stop_machines = "suspend"` and
`min_machines_running = 0`, then `fly deploy`. First request after idle incurs a cold start.
(Keep the Mongo app always-on — it has no HTTP trigger to wake it.)

### Swap Mongo for MongoDB Atlas M0 (free, optional)
Create an Atlas M0 cluster, allow Fly egress IPs, then:
```bash
fly secrets set MONGODB_URI="mongodb+srv://user:pass@cluster/opensign?retryWrites=true&w=majority" \
  --app docsign-bettersign-api
# then: fly apps destroy docsign-bettersign-mongo
```

### Add a branded API domain later (optional)
Use a **one-label** host like `docsign-api.betterid.net` (covered by the universal cert):
`fly certs add docsign-api.betterid.net --app docsign-bettersign-api`, add a DNS-only
(grey-cloud) CNAME → `docsign-bettersign-api.fly.dev`, then rebuild the frontend with
`REACT_APP_SERVERURL=https://docsign-api.betterid.net/app` and update the backend
`SERVER_URL` secret to match.

---

## 8. Reproducing from scratch

Prereqs: `cf` authenticated (`cf auth whoami`), `flyctl` authenticated (`fly auth whoami`),
the `betterid.net` zone in the Cloudflare account (and `bettersign.ing` for the old-name redirect).

1. **Generate secrets:** `APP_ID` (12 hex), `MASTER_KEY` (strong random), Mongo user/pass.
2. **Mongo app:** `fly apps create docsign-bettersign-mongo`; `fly volumes create mongo_data --size 1 --region sjc`; `fly secrets set MONGO_INITDB_ROOT_USERNAME/PASSWORD --stage`; deploy with `deploy/fly-mongo/fly.toml` (command must include `--ipv6`).
3. **Backend app:** `fly apps create docsign-bettersign-api`; `fly volumes create opensign_files --size 1 --region sjc`; set secrets `APP_ID`, `MASTER_KEY`, `MONGODB_URI` (`...@docsign-bettersign-mongo.internal:27017/opensign?authSource=admin`), `SERVER_URL`; `cd apps/OpenSignServer && fly deploy`.
4. **Frontend:** write `apps/OpenSign/.env` (`REACT_APP_SERVERURL`, `REACT_APP_APPID`); `npm install && npm run build`; deploy per §7 using `deploy/cloudflare-frontend/`; the `domains` key wires `docsign.betterid.net`.

### `cf` CLI gotchas (beta) learned here
- `cf` uses **Workers Static Assets**, not legacy Pages. Deploy with `cf deploy`.
- Config is split: **`wrangler.config.ts`** = build options (`assetsDirectory`); **`cloudflare.config.ts`** = worker/deploy options (`name`, `compatibilityDate`, `assets.notFoundHandling`, `domains`).
- Custom domains = `worker.domains: string[]` (not `routes`). `triggers` is for event handlers (`fetch`/`scheduled`/`queue`/`email`), not domains.
- Deploy from a directory **without** `vite.config.js`/app `package.json`, or `cf` tries to re-detect the framework and rebuild (the app's `@cloudflare/vite-plugin` path fails).

---

## 9. Files added to the repo by this deployment

| Path | Purpose |
|---|---|
| `apps/OpenSignServer/Dockerfile` | Backend image for Fly |
| `apps/OpenSignServer/fly.toml` | Backend Fly config |
| `deploy/fly-mongo/fly.toml` | MongoDB Fly config |
| `deploy/cloudflare-frontend/` | Frontend `cf` deploy config |
| `apps/OpenSign/.env` | Frontend build-time env (non-secret: API URL + APP_ID) |
| `DEPLOYMENT.md` | This document |
| `DEPLOYMENT-SECRETS.local.txt` | Secrets backup (gitignored — do **not** commit) |
