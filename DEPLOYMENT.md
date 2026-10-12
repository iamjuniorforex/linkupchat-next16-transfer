# LINKUPCHAT — Deployment Guide

This document explains exactly how to deploy LINKUPCHAT to a real production
environment and upload the project to GitHub.

---

## 1. Architecture summary

LINKUPCHAT runs as **one persistent Node.js process** (see `server.ts`):

```
server.ts
├── Next.js 14 (App Router)      → serves the UI + REST API
└── Socket.IO (same HTTP server) → realtime messages, presence, typing,
                                   read receipts, WebRTC call signaling
```

* One process, one port (`PORT`, default 3000), bound to `HOST=0.0.0.0`.
* `npm start` runs `prisma migrate deploy` and then boots the server.
* PostgreSQL is the system of record (Prisma ORM).
* Media is stored in S3-compatible object storage (or local disk for dev).

---

## 2. Is the current Next.js + Socket.IO architecture suitable for Vercel?

### **No. Vercel is not suitable for this architecture.**

| Reason | Detail |
|---|---|
| **Custom servers are not supported** | Vercel runs Next.js as managed serverless/edge functions. It ignores `server.ts` — the process that hosts Socket.IO would never run. |
| **No persistent WebSocket connections** | Socket.IO needs long-lived connections. Vercel serverless functions are ephemeral with execution limits — WebSocket upgrades are not supported, and long-polling degrades badly under this model. |
| **In-memory realtime state** | Socket.IO keeps rooms, presence and call signaling state in process memory. Serverless instances are cold-started, scaled and destroyed at will. |

Running LINKUPCHAT on Vercel **would require a rewrite** (splitting realtime into a
separate service and pointing the client at it). This guide intentionally avoids that.

### ✅ Recommended hosts (run the current architecture unchanged)

| Provider | Why it fits | Setup in this doc |
|---|---|---|
| **Railway** (recommended) | Persistent Node service, WebSockets first-class, managed PostgreSQL, git-based deploys, env-var UI | §5.1 |
| **Render** (alternative) | Persistent "Web Service" + managed Postgres, WebSockets supported | §5.2 |
| **Fly.io** (Docker) | Persistent micro-VMs, WebSockets first-class, global regions | §5.3 (uses the included `Dockerfile`) |
| **Any VPS** (Hetzner, DigitalOcean, AWS EC2…) | Full control; Node 20 + PostgreSQL + nginx | §5.4 |

All of them run the exact commands:

```bash
npm install
npm run build
npm start
```

---

## 3. Prerequisites

* Node.js **20+** (`engines` is pinned in `package.json`)
* PostgreSQL **14+** (managed or self-hosted)
* (Production media) an S3-compatible bucket — AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces…
* (Optional) SMTP account, VAPID keys for push, TURN server for calls

---

## 4. Environment variables

Set these in your host's dashboard (never commit them — `.env` is gitignored,
`.env.example` is the template). All configuration is read from the environment.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (Prisma) |
| `NEXT_PUBLIC_APP_URL` | ✅ | Public URL of the deployment (email links) |
| `HOST` | ✅ | Bind address — keep `0.0.0.0` on PaaS hosts |
| `PORT` | ✅ | HTTP port (hosts often inject this — use their value) |
| `SESSION_TTL_DAYS` | ⬜ | Session lifetime (default 30) |
| `STORAGE_DRIVER` | ✅ | `s3` in production (`local` only for dev) |
| `UPLOAD_DIR` | ⬜ | Local storage path (dev) |
| `MAX_UPLOAD_MB` | ⬜ | Upload size cap (default 25) |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | ✅ (with `s3`) | Object storage |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | ✅ (with `s3`) | Object storage credentials |
| `S3_PUBLIC_URL` | ⬜ | CDN/bucket public base URL for media |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | ⬜ | Email delivery (verify + password reset) |
| `MAIL_FROM` | ⬜ | From-address for outgoing mail |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | ⬜ | Web push (`npx web-push generate-vapid-keys`) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | ⬜ | Same public key, exposed to the client |
| `NEXT_PUBLIC_TURN_URL` / `_USERNAME` / `_CREDENTIAL` | ⬜ | TURN servers for production WebRTC |
| `ALLOWED_FRAME_ORIGINS` | ⬜ | Origins allowed to frame the app (default: `X-Frame-Options: DENY`) |

Notes:
* The session system uses random, hashed tokens — no signing secret is required.
* With `STORAGE_DRIVER=s3`, media is stored via the bundled S3 client
  (`@aws-sdk/client-s3`) against any S3-compatible endpoint (AWS S3, Cloudflare
  R2, MinIO, DigitalOcean Spaces) using the `S3_*` variables — nothing else to install.
* Without SMTP, password-reset emails are logged to the server console (dev mode only).

---

## 5. Provider-specific deployment

### 5.1 Railway (recommended)

1. Push the project to GitHub (§6).
2. **New Project → Deploy from GitHub repo**.
3. Add a **PostgreSQL** database (Railway → New → Database → PostgreSQL).
4. In the service **Variables**, set `DATABASE_URL` (Railway provides
   `DATABASE_URL` automatically when you reference the Postgres service),
   `NEXT_PUBLIC_APP_URL=https://<your-app>.up.railway.app`, `STORAGE_DRIVER=s3`
   + the `S3_*` variables (or `local` + a Railway **Volume** mounted at
   `/app/uploads` for simple persistent media).
5. **Build settings**: build command `npm run build`, start command `npm start`.
6. Deploy. `npm start` applies Prisma migrations automatically
   (`prisma migrate deploy`) and boots Next.js + Socket.IO.
7. Health check path: `/api/health`.
8. Seed the first admin via a one-off shell (Railway → Run): `npm run db:seed`
   (dev demo only — create real users through registration instead).

WebSockets work out of the box on Railway's edge.

### 5.2 Render

1. Push to GitHub.
2. **New → Web Service** → connect the repo.
3. Runtime: Node; Build: `npm run build`; Start: `npm start`.
4. Add a **Render PostgreSQL** database and set `DATABASE_URL`.
5. Set the remaining env vars (§4). Health check path: `/api/health`.
6. Note: Render's free tier sleeps and is not suitable for production. Use a
   paid instance — WebSockets are fully supported on paid plans.

### 5.3 Fly.io (Docker — Dockerfile included)

```bash
fly launch --no-deploy        # detects the included Dockerfile
fly postgres create           # or attach an external Postgres
fly secrets set DATABASE_URL=postgresql://... NEXT_PUBLIC_APP_URL=https://<app>.fly.dev
fly deploy
```
Mount a volume for `/app/uploads` if using `STORAGE_DRIVER=local`.

### 5.4 Any VPS (systemd + nginx)

```bash
# install Node 20 + PostgreSQL, create DB and user, then:
git clone <your-repo> /opt/linkupchat && cd /opt/linkupchat
cp .env.example .env   # fill in values
npm install
npm run build
sudo useradd -r linkupchat
```

systemd unit (`/etc/systemd/system/linkupchat.service`):

```ini
[Unit]
Description=LINKUPCHAT
After=network.target postgresql.service

[Service]
Type=simple
User=linkupchat
WorkingDirectory=/opt/linkupchat
EnvironmentFile=/opt/linkupchat/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

nginx must forward WebSocket upgrades:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;   # keep Socket.IO connections alive
}
```

---

## 6. Upload to GitHub

```bash
cd linkupchat
git init
git add .
git status            # VERIFY: .env is NOT listed, node_modules is NOT listed
git commit -m "LINKUPCHAT: production-ready messaging platform"
git branch -M main
git remote add origin git@github.com:<you>/linkupchat.git
git push -u origin main
```

`.gitignore` already excludes: `node_modules/`, `.env`, `.env.*` (except
`.env.example`), `.next/`, database files (`*.db`, `*.sqlite*`), logs,
`uploads/` contents, temp files, editor/OS junk.

---

## 7. Database migrations (hosted PostgreSQL)

* The full schema lives in `prisma/schema.prisma` and the initial migration in
  `prisma/migrations/0_init/` (18 tables, enums, indexes — provider `postgresql`).
* `npm start` runs `prisma migrate deploy` first, so a fresh database is
  migrated automatically at boot. You may instead run it as a **release
  command** and use `npm run start:server-only`.
* For local development against a scratch DB: `npm run db:push`.
* **Never** run `npm run db:seed` in production — it refuses to run when
  `NODE_ENV=production` (demo password `linkup123` is development-only).

---

## 8. Hosting requirements for the persistent Socket.IO server

1. **Long-running process** — the app is NOT serverless-compatible. The host
   must run a persistent Node.js service (Railway/Render/Fly/VPS).
2. **WebSocket support** — the proxy/edge must forward `Upgrade`/`Connection`
   headers and not kill idle sockets (Socket.IO pings every 25 s; set proxy
   read timeouts ≥ 60 s, ideally hours — see nginx config above).
3. **Single instance today** — presence/typing/call state is in memory. Run ONE
   instance. To scale horizontally later: sticky sessions + the Redis adapter
   for Socket.IO + Redis-backed rate limiting (integration points are isolated
   in `src/lib/realtime.ts` and `src/lib/rate-limit.ts`).
4. **Same origin** — the Socket.IO client connects to the same host/port as the
   web app (`/socket.io`), so no extra CORS or second service is needed.
5. **Health check** — `GET /api/health` returns 200 when the app and database
   are healthy (503 otherwise).
6. **File system** — if `STORAGE_DRIVER=local`, uploads need a persistent disk
   (volume). Prefer S3 in production.
7. **Process manager** — the platform (or systemd) must restart the process on
   crash (`Restart=always` above).

---

## 9. Post-deploy tasks

1. Open `https://<your-domain>/` — landing page loads.
2. Register a real account → login works → send a message between two accounts
   (realtime delivery, typing, read receipts).
3. Upload an image → stored per `STORAGE_DRIVER`.
4. Trigger "Forgot password" → check the SMTP inbox.
5. Visit `/api/health` → `{"status":"healthy"}`.
6. Create your admin: register a user, then promote via SQL:
   `UPDATE "User" SET role='ADMIN' WHERE username='<you>';`
7. Configure TURN for reliable calls behind strict NATs.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Boot fails: `Can't reach database server` | Wrong `DATABASE_URL` / firewall | Use the host's connection string; allow the app's egress IP |
| `prisma migrate deploy` errors on existing DB | DB was created with `db push` earlier | Start from an empty DB, or baseline: `prisma migrate resolve --applied 0_init` |
| WebSockets fall back to polling / disconnect | Reverse proxy killing upgrades | Forward `Upgrade`/`Connection` headers (§5.4) |
| Media 404 after redeploy | Local storage on ephemeral disk | Use `STORAGE_DRIVER=s3` or a mounted volume |
| Emails not arriving | SMTP unset/wrong | Verify `SMTP_*`; in dev, emails print to the console |
| Calls connect audio-only one way | Symmetric NAT | Configure `NEXT_PUBLIC_TURN_*` |

See `PRODUCTION-CHECKLIST.md` for the full pre-launch checklist.
