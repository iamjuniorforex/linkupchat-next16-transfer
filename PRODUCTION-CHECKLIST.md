# LINKUPCHAT — Production Checklist

Work through every section before opening the app to real users.
(Companion document: `DEPLOYMENT.md`.)

## A. Repository hygiene (GitHub)

- [ ] `.gitignore` covers `node_modules/`, `.env`, `.env.*` (with `!.env.example`),
      `.next/`, `*.db`/`*.sqlite*`, `logs/`, `*.log`, `tmp/`, `uploads/` contents
- [ ] `git status` before the first commit shows **no** `.env`, secrets, or build output
- [ ] `.env.example` lists every variable in `DEPLOYMENT.md` §4 with empty/example values
- [ ] No hard-coded credentials anywhere in source (`grep -ri "password" src` review)
- [ ] README and DEPLOYMENT links point to the final repo/URLs

## B. Secrets & configuration

- [ ] All env vars set in the host dashboard (not in files)
- [ ] `DATABASE_URL` points at the hosted PostgreSQL with a strong password
- [ ] `NEXT_PUBLIC_APP_URL` = the real `https://` origin
- [ ] `STORAGE_DRIVER=s3` with real `S3_*` credentials (or a mounted volume + `local`)
- [ ] `MAIL_FROM` and `SMTP_*` configured and tested
- [ ] VAPID keys generated and set (`VAPID_*` + `NEXT_PUBLIC_VAPID_PUBLIC_KEY`)
- [ ] TURN credentials set for calls (`NEXT_PUBLIC_TURN_*`)
- [ ] `ALLOWED_FRAME_ORIGINS` left empty (default `X-Frame-Options: DENY`)

## C. Database

- [ ] Provisioned PostgreSQL 14+ with daily automated backups + point-in-time recovery
- [ ] `prisma migrate deploy` applies cleanly (`npm start` does this automatically)
- [ ] Schema has 18 tables (`\dt` in psql)
- [ ] Demo seed data **not** loaded (seed refuses under `NODE_ENV=production`)
- [ ] First real admin promoted manually (`UPDATE "User" SET role='ADMIN' ...`)
- [ ] Backups restored at least once as a drill

## D. Platform (persistent Node + Socket.IO)

- [ ] Host runs a **persistent** service (NOT serverless) — see DEPLOYMENT.md §2
- [ ] WebSockets enabled; reverse proxy forwards `Upgrade`/`Connection` and keeps
      idle sockets ≥ 60 s (DEPLOYMENT.md §5.4 nginx config)
- [ ] Single app instance (in-memory realtime state) — scale plan documented
- [ ] Health check configured on `/api/health`
- [ ] Restart-on-crash enabled (platform default or systemd `Restart=always`)
- [ ] Logs shipped somewhere retrievable (platform dashboard or aggregator)

## E. Security

- [ ] HTTPS enforced at the edge (host-managed TLS certificate)
- [ ] Security headers present (next.config.mjs): CSP, X-Frame-Options DENY,
      nosniff, referrer-policy, permissions-policy — verify with `curl -I`
- [ ] Rate limiting verified on `/api/auth/*` (too many logins → 429)
- [ ] Session cookie is `HttpOnly` + `SameSite=Lax` + `Secure` in production
- [ ] Upload size cap (`MAX_UPLOAD_MB`) enforced; media served with correct
      `Content-Type` and `Content-Disposition` policy
- [ ] Admin area (`/admin`) requires role ADMIN (test with a normal user → 403)
- [ ] Dependency audit: `npm audit` reviewed before launch

## F. Functional smoke test (staging URL)

- [ ] `/` landing page renders
- [ ] Register → verify → login → onboarding flow completes
- [ ] 1:1 chat: message, edit, delete, reply, forward, react (two accounts)
- [ ] Realtime: typing indicator, delivered ✓✓, read receipts, presence
- [ ] Group create → group chat works
- [ ] 24h status post → view → expiry
- [ ] Image/file upload → shows in chat → persists after refresh
- [ ] Voice note record/play; calls ring and connect (two devices)
- [ ] Push notification prompt + notification history
- [ ] Settings: theme, privacy (about/last-seen/receipts), block, report
- [ ] Search users/messages; context menu actions
- [ ] Password reset email → new password → login
- [ ] `/api/health` returns `{"status":"healthy"}`
- [ ] `/api/health` DB failure path returns 503 when DB is stopped (staging only)

## G. Post-launch

- [ ] Uptime monitoring on `/api/health` (e.g. UptimeRobot, Better Stack)
- [ ] Error tracking wired (platform logs or Sentry — optional integration)
- [ ] Backup retention + restore owner assigned
- [ ] Abuse handling runbook (block/report → admin dashboard review)
- [ ] Status page / incident contact for users
