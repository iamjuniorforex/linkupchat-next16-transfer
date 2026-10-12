# LINKUPCHAT ⚡

**Stay connected. Link up.**

LINKUPCHAT is a fast, modern social messaging platform — chats, groups, voice & video calls,
status stories, reactions and more — with an original brand identity, a polished mobile-first
UI, and a production-grade architecture built on Next.js, TypeScript, PostgreSQL and WebSockets.

---

## ✨ Features

### Phase 1 — Foundation
- ✅ Original landing page (hero, features, privacy, cross-device, CTA)
- ✅ Complete authentication: register, login, logout, password reset, change password,
  session management, login history
- ✅ User profiles with avatar, bio, join date, online status & last seen
- ✅ PostgreSQL schema (18 tables) with enums, relations and indexes
- ✅ Main dashboard: desktop 2-pane layout + mobile bottom-tab navigation
- ✅ Contacts: search, add, remove, block, start conversations
- ✅ One-to-one real-time messaging with delivery & read receipts
- ✅ Real-time layer: Socket.IO with auth, presence, typing indicators

### Phase 2 — Messaging depth
- ✅ Media sharing: images, videos, audio, voice messages, documents (validated, size-capped,
  object-storage abstraction)
- ✅ Message reactions (❤️ 😂 👍 😮 😢 😡) with counts
- ✅ Reply to specific messages, edit, delete (for me / for everyone), forward, copy
- ✅ Global search (users, chats, messages) + in-conversation search with highlighting
- ✅ In-app notification feed with unread counts

### Phase 3 — Social & privacy
- ✅ Group chats: create, name, description, add/remove members, admins, promote/demote,
  permissions (who can send messages / edit info / add members)
- ✅ Status stories: text/image/video, 24h expiry, viewers list, privacy-scoped
- ✅ Privacy settings: last seen, online, profile photo, about, status, read receipts
- ✅ Block/unblock, report users & messages (6 categories) with moderation queue

### Phase 4 — Calls & platform
- ✅ Voice & video calls over WebRTC with Socket.IO signaling: incoming/outgoing screens,
  accept/decline/end, mute mic, camera toggle, call history
- ✅ Production-grade ICE/TURN connectivity: server-authoritative ICE config (STUN + optional
  provider-agnostic TURN with UDP/TCP/TLS), authenticated `GET /api/calls/ice`, direct-first
  → TURN-fallback, recoverable ICE failures with 5s disconnect grace
- ✅ Push notification architecture (web-push/VAPID integration layer)
- ✅ Admin dashboard: stats, user moderation (suspend/ban/roles), report resolution
- ✅ Rate limiting, session revocation, hashed tokens, XSS/SQLi/CSRF-hardened patterns
- ✅ Optimistic UI, infinite scroll, skeletons, toasts, dark/light/system themes, a11y

---

## 🧱 Tech stack

| Layer | Choice |
|---|---|
| Web app | Next.js 14 (App Router), React 18, TypeScript |
| Styling | Tailwind CSS (custom design tokens, dark mode) |
| API | REST route handlers with Zod validation |
| Database | PostgreSQL + Prisma ORM |
| Realtime | Socket.IO (auth, rooms, presence, typing, WebRTC signaling) |
| Auth | Cookie sessions (httpOnly), bcrypt (cost 12), hashed tokens |
| Media | Object storage abstraction (local disk dev / S3 production) |
| Calls | Native WebRTC (STUN + optional TURN) |

## 🚀 Getting started

### 1. Requirements
- Node.js 20+
- PostgreSQL 14+ (a database named `linkupchat`)

### 2. Setup

```bash
# install dependencies
npm install

# configure environment
cp .env.example .env
# edit DATABASE_URL to point at your PostgreSQL instance

# create the schema
npx prisma db push

# seed demo users + conversations (dev only)
npm run db:seed

# start the app (Next.js + Socket.IO on one port)
npm run dev
```

Open **http://localhost:3000**

### 3. Demo accounts (seed data)

Password for all: `linkup123`

| Username | Name | Notes |
|---|---|---|
| `alex` | Alex Mensah | Main demo user with chats + groups |
| `sarah` | Sarah Okafor | Online, active conversations |
| `sophia` | Sophia Diallo | Online, has status updates |
| `daniel` `emma` `michael` `jay` | — | Contacts with conversations |
| `admin` | LINKUP Admin | Access to `/admin` dashboard |

> Demo/seed data is created by `prisma/seed.ts` and is clearly separated from production data.

## 🔐 Environment variables

All secrets live in environment variables (see `.env.example`). Never hard-code credentials.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SECRET` | Secret for signing/verification |
| `SESSION_TTL_DAYS` | Session lifetime (default 30) |
| `STORAGE_DRIVER` | `local` (dev) or `s3` (production) |
| `UPLOAD_DIR` / `MAX_UPLOAD_MB` | Local storage path / upload size cap |
| `S3_*` | Object storage credentials (production media) |
| `SMTP_*` / `MAIL_FROM` | Email delivery (verification, password reset) |
| `VAPID_*` / `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web push notifications |
| `NEXT_PUBLIC_APP_URL` | Public base URL (email links) |
| `STUN_URLS` | Optional comma-separated `stun:`/`stuns:` URLs (default: public Google STUN) |
| `TURN_URLS` | Optional comma-separated `turn:`/`turns:` URLs for production WebRTC relay |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | TURN account credentials (server-side only — never `NEXT_PUBLIC_*`) |

### TURN / ICE configuration (Phase 4E)

Calling uses **direct peer-to-peer ICE first** (host + STUN reflexive candidates) and falls
back to a **TURN relay** when direct connectivity fails. Configuration is server-authoritative:
the browser fetches only the ICE-server list it needs from `GET /api/calls/ice`
(authenticated users only); TURN credentials are never rendered into HTML, never written to
logs, and never compiled into the public JS bundle.

All four variables are optional — **the app starts and calling keeps working (STUN/direct)
when none are set**. When you are ready for production-grade NAT traversal, create a managed
TURN account (Cloudflare Calls, Metered, Twilio NTS, … — anything with username/credential
auth) and set on Railway:

```bash
STUN_URLS=stun:stun.example.com:3478                     # optional; default is fine
TURN_URLS=turn:relay.example.com:3478,turn:relay.example.com:3478?transport=tcp,turns:relay.example.com:5349
TURN_USERNAME=<account username>                          # e.g. Cloudflare/Metered/Twilio value
TURN_CREDENTIAL=<account credential>
```

- Multiple `TURN_URLS` are supported; `?transport=udp` (default) and `?transport=tcp` are
  honored, `turns:` implies TLS — list several so restrictive firewalls still connect.
- Misconfiguration never crashes the server: invalid URLs are skipped and a credential-free
  warning is logged (`[ice] …`), and calls degrade to STUN/direct ICE.
- **Note:** static TURN credentials are visible to your own authenticated users (inherent to
  static TURN auth). Time-limited HMAC credentials (TURN REST API) can replace them later
  without any client change.

## 🗄️ Database

18 tables — `User`, `Session`, `PasswordReset`, `VerificationToken`, `LoginEvent`, `Contact`,
`BlockedUser`, `Conversation`, `ConversationMember`, `Message`, `MessageReaction`, `Attachment`,
`Status`, `StatusView`, `Call`, `Notification`, `Report`, `UserSettings`.

Highlights:
- `Message(conversationId, createdAt DESC)` index for paginated history
- Soft deletes + edit timestamps on messages
- `Conversation.directKey` unique constraint — one conversation per pair
- Group permissions flags on `Conversation`
- Privacy levels per user in `UserSettings`
- Moderation-ready `Report` table with status workflow

## 🧩 Architecture notes

```
server.ts            → single Node process: Next.js + Socket.IO (shared io instance)
src/app/api/**       → REST route handlers (auth, users, conversations, messages, admin…)
src/lib/**           → db, auth-core, storage, validation, rate-limit, realtime bridge
src/context/**       → AuthProvider, SocketProvider, ChatProvider, CallProvider, ThemeProvider
src/components/**    → UI kit, landing, chat, app shell components
shared/events.ts     → realtime event contract shared by server & client
prisma/**            → schema + seed
```

### Realtime flow
API handlers and the Socket.IO server run in the same process; handlers emit through
`src/lib/realtime.ts` to conversation/user rooms. Clients reconcile optimistic messages via
`clientNonce`. For horizontal scaling, move presence/rooms to Redis (`@socket.io/redis-adapter`)
and rate limits to Redis — the integration points are isolated in `lib/realtime.ts` and
`lib/rate-limit.ts`.

### E2E encryption
Messages are protected by transport security, session auth and per-conversation access
control. The message pipeline (client → REST → rooms) is structured so real end-to-end
encryption can be layered on properly (per-session keys, prekey bundles) — we deliberately do
**not** claim E2E encryption today.

### Media storage
Uploads are validated (type + size), written through `lib/storage.ts` to disk in development
or S3 in production (`STORAGE_DRIVER=s3` + `S3_*` vars). Files are served through an
authenticated route — large media never enters the database.

## 🧪 Testing performed

- ✅ Type-check (`tsc --noEmit`) and production build (`next build`)
- ✅ Auth: register, duplicate-username rejection, login, logout, password reset round-trip,
  change password, session list/revocation
- ✅ Messaging: send (optimistic nonce), paginate, edit, delete, forward, react
- ✅ Realtime E2E (2 sockets): typing indicators, live message delivery, read receipts
- ✅ Groups: create with members, permissions, system messages
- ✅ Search: global + in-chat with highlighted matches
- ✅ Upload: PNG validated, stored, attachment created
- ✅ Admin: role-gated (403 for normal users), stats, moderation actions
- ✅ Status API + 24h expiry, notifications, calls history

## 📱 Responsive support

320px → 1920px. Mobile gets a bottom tab bar and full-screen conversations; desktop gets a
sidebar + conversation pane. Light/dark/system themes, reduced-motion support, keyboard
navigation and screen-reader labels throughout.

## 🗺️ Production roadmap

- [ ] Redis adapter for Socket.IO + distributed rate limiting
- [ ] S3 uploads wired via `@aws-sdk/client-s3` (integration point ready)
- [ ] SMTP via nodemailer (integration point ready)
- [ ] Web push via `web-push` + VAPID (integration point ready)
- [x] TURN/ICE configuration: server-authoritative, provider-agnostic env config
  (`TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL`) delivered via authenticated `GET /api/calls/ice`
  — wire a managed TURN provider on Railway when needed
- [ ] True end-to-end encryption (MLS/Signal-style sessions)
- [ ] Message virtualization for 100k+ message histories
