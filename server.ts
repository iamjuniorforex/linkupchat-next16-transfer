/**
 * LINKUPCHAT custom server — runs Next.js and the Socket.IO realtime layer
 * on a single HTTP server/port.
 *
 *   Dev:  npm run dev
 *   Prod: npm run build && npm start
 */
import http from 'http';
import next from 'next';
import { parse } from 'url';
import { Server as IOServer, type Socket } from 'socket.io';
import { db } from './src/lib/db';
import { runRetentionSweep } from './src/lib/retention';
import { getSessionAuthFromToken, getSessionUserFromToken, SESSION_COOKIE, hashToken } from './src/lib/auth-core';
import { setViewer, clearViewer } from './src/lib/realtime';
import { randomUUID } from 'crypto';
import { EVENTS, ROOM, type CallSignalPayload } from './shared/events';
import {
  beginCall,
  acceptCall,
  endCall,
  abortCall,
  resolveCallFor,
  findCallBySocketId,
  getCallForUser,
  otherParticipant,
  sweepStaleCalls,
  setOnRingTimeout,
  type CallOutcome
} from './src/lib/call-state';
import { reconcileStaleCallRows } from './src/lib/calls-reconcile';
import { isUserInGroupCall } from './src/lib/group-call-state';
import {
  installGroupCallRuntime,
  onGroupSocketDisconnect,
  registerGroupCallSocket
} from './src/lib/group-call-server';
import { getIceConfig, describeIceConfigForLog } from './src/lib/ice-config';
import {
  buildMissedCallNotification,
  buildMissedCallData,
  parseNotificationData
} from './src/lib/notifications';
import { getActiveViewers } from './src/lib/realtime';
import { dispatchPush } from './src/lib/push';
import { pushIncomingCall } from './src/lib/call-notify';

const dev = process.env.NODE_ENV !== 'production';
// Bind to 0.0.0.0 so the platform's Live Preview proxy can reach the server.
// (Use HOST — not HOSTNAME, which shells set to a machine name like `e2b.local`.)
const hostname = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

interface SocketData {
  userId: string;
  username: string;
  displayName: string;
  /** Session identity bound at connect — used to invalidate this socket on revocation. */
  sessionId: string;
  conversationIds: Set<string>;
}

/** Parse cookies from the raw handshake headers. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

/** User ids that share at least one active conversation with userId. */
async function conversationPeers(userId: string): Promise<Set<string>> {
  const memberships = await db.conversationMember.findMany({
    where: { userId, leftAt: null },
    select: {
      conversationId: true,
      conversation: {
        select: {
          members: { where: { leftAt: null }, select: { userId: true } }
        }
      }
    }
  });
  const peers = new Set<string>();
  for (const m of memberships) {
    for (const member of m.conversation.members) {
      if (member.userId !== userId) peers.add(member.userId);
    }
  }
  return peers;
}

/**
 * Fan out presence only to users the emitter actually knows (conversation
 * peers + contact pairs), and only the fields their privacy settings allow.
 * Unknown users never receive presence events at all.
 */
async function broadcastPresence(
  io: IOServer,
  userId: string,
  online: boolean,
  lastSeenAt: Date | null
) {
  const [settings, peerSet, savedMe, iSaved] = await Promise.all([
    db.userSettings.findUnique({
      where: { userId },
      select: { privacyOnline: true, privacyLastSeen: true }
    }),
    conversationPeers(userId),
    db.contact.findMany({ where: { contactId: userId }, select: { ownerId: true } }),
    db.contact.findMany({ where: { ownerId: userId }, select: { contactId: true } })
  ]);

  // Same semantics as profile/search privacy: CONTACTS = viewers who saved
  // this user (ownerId = viewer, contactId = target).
  const contactViewers = new Set(savedMe.map((c) => c.ownerId));
  const levelOnline = settings?.privacyOnline ?? 'EVERYONE';
  const levelLastSeen = settings?.privacyLastSeen ?? 'EVERYONE';
  const allowOnline = (v: string) =>
    levelOnline === 'EVERYONE' || (levelOnline === 'CONTACTS' && contactViewers.has(v));
  const allowLastSeen = (v: string) =>
    levelLastSeen === 'EVERYONE' || (levelLastSeen === 'CONTACTS' && contactViewers.has(v));

  const audience = new Set<string>([...peerSet, ...savedMe.map((c) => c.ownerId), ...iSaved.map((c) => c.contactId)]);
  for (const viewerId of audience) {
    const canOnline = allowOnline(viewerId);
    const canLastSeen = allowLastSeen(viewerId);
    if (!canOnline && !canLastSeen) continue;
    io.to(ROOM.user(viewerId)).emit(EVENTS.PRESENCE_UPDATE, {
      userId,
      online: canOnline ? online : false,
      lastSeenAt: canLastSeen && lastSeenAt ? lastSeenAt.toISOString() : null
    });
  }
}

async function start() {
  await app.prepare();

  // Phase 4E: validate the ICE/TURN environment up front. Log lines are
  // credential-free by construction (see ice-config.ts); misconfiguration
  // degrades to STUN/direct ICE instead of crashing the server.
  const ice = getIceConfig();
  console.log(`  [ice] ${describeIceConfigForLog(ice)}`);
  for (const w of ice.warnings) console.warn(`  [ice] warning: ${w}`);

  const server = http.createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // Socket handshake CORS: allow only the app origin(s) plus non-browser
  // clients (no Origin header — Node tests, curl). Cookies are SameSite=Lax,
  // so this is defense-in-depth on top of session auth in the middleware.
  const socketAllowedOrigins = new Set(
    [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL, `http://localhost:${Number(process.env.PORT ?? 3300)}`, `http://127.0.0.1:${Number(process.env.PORT ?? 3300)}`]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.replace(/\/$/, ''))
  );
  const io = new IOServer(server, {
    path: '/socket.io',
    cors: {
      origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
        cb(null, !origin || socketAllowedOrigins.has(origin.replace(/\/$/, ''))),
      credentials: true
    },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Signaling messages (SDP/ICE) are small; cap abuse payloads. Real chat
    // media goes over HTTP/R2, never over the socket.
    maxHttpBufferSize: 256 * 1024
  });

  // Expose the io instance to Next.js API route handlers (same process).
  (globalThis as Record<string, unknown>).__LINKUP_IO = io;

  // ── Phase 4A: call conclusion (persist + signal) ──────────────────────────
  // Single place that writes the Call row and notifies both participants
  // after a registry transition succeeded. `durationSec` is always computed
  // server-side from the accept time — client values are ignored.
  async function concludeCall(res: CallOutcome, originUserId: string | null) {
    await db.call
      .updateMany({
        where: { id: res.call.callId, OR: [{ status: 'RINGING' }, { status: 'CONNECTED' }] },
        data: { status: res.status, endedAt: new Date(), durationSec: res.durationSec }
      })
      .catch(() => {});

    const from = originUserId ?? res.call.callerId;

    if (res.status === 'DECLINED') {
      // Recipient refused a ringing call — reuse the existing declined event
      // so current client UX ("Call declined") stays correct.
      io.to(ROOM.user(res.call.callerId)).emit(EVENTS.CALL_REJECT, {
        callId: res.call.callId,
        from: res.call.calleeId
      });
      return;
    }

    const endPayload = {
      callId: res.call.callId,
      from,
      durationSec: res.durationSec,
      reason: res.reason
    };
    io.to(ROOM.user(res.call.callerId)).emit(EVENTS.CALL_END, endPayload);
    io.to(ROOM.user(res.call.calleeId)).emit(EVENTS.CALL_END, endPayload);

    // Phase 4B: missed-call notification for the callee (Phase 2 rules:
    // notifCalls respected, never created while the callee is actively
    // viewing the conversation, minimal body — no call content).
    if (res.status === 'MISSED' && res.call.conversationId) {
      try {
        const viewing = getActiveViewers(res.call.conversationId).includes(res.call.calleeId);
        if (!viewing) {
          const callee = await db.user.findUnique({
            where: { id: res.call.calleeId },
            select: { settings: { select: { notifEnabled: true, notifCalls: true } } }
          });
          const caller = await db.user.findUnique({
            where: { id: res.call.callerId },
            select: { displayName: true }
          });
          if (caller && (callee?.settings?.notifCalls ?? true) && (callee?.settings?.notifEnabled ?? true)) {
            const { title, body } = buildMissedCallNotification({
              callerName: caller.displayName,
              callKind: res.call.type
            });
            const row = await db.notification.create({
              data: {
                userId: res.call.calleeId,
                type: 'CALL',
                title,
                body,
                data: buildMissedCallData({
                  callId: res.call.callId,
                  conversationId: res.call.conversationId,
                  peerId: res.call.callerId,
                  callKind: res.call.type
                })
              }
            });
            io.to(ROOM.user(res.call.calleeId)).emit(EVENTS.NOTIFICATION_NEW, {
              id: row.id,
              type: row.type,
              title: row.title,
              body: row.body,
              data: parseNotificationData(row.data),
              readAt: row.readAt?.toISOString() ?? null,
              createdAt: row.createdAt.toISOString()
            });

            // Web Push for missed calls (notifCalls already checked above).
            void dispatchPush({
              userId: res.call.calleeId,
              kind: 'CALL',
              title: row.title,
              body: row.body ?? undefined,
              notificationId: row.id,
              data: { url: '/app/calls' },
              tag: `call:${res.call.callId}`
            }).catch(() => {});
          }
        }
      } catch {
        // A notification failure must never affect call conclusion.
      }
    }
  }

  // Ring timer expiry → missed call (status MISSED + timeout signal to both).
  setOnRingTimeout((callId) => {
    void (async () => {
      const res = endCall({ callId, userId: '', via: 'timeout' });
      if (res) await concludeCall(res, res.call.callerId);
    })();
  });

  // Defence in depth: conclude registry entries that outlived their timers.
  const sweepTimer = setInterval(() => {
    void (async () => {
      for (const res of sweepStaleCalls()) await concludeCall(res, null);
    })();
  }, 60_000);
  sweepTimer.unref();

  // Orphaned Call rows from a previous process converge to final states.
  await reconcileStaleCallRows().catch(() => {});
  installGroupCallRuntime(io);

  // ── Auth middleware ──
  io.use(async (socket, nextFn) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const auth = await getSessionAuthFromToken(cookies[SESSION_COOKIE]);
      if (!auth) {
        nextFn(new Error('UNAUTHORIZED'));
        return;
      }
      (socket.data as SocketData).userId = auth.user.id;
      (socket.data as SocketData).username = auth.user.username;
      (socket.data as SocketData).displayName = auth.user.displayName;
      // Session identity for revocation fan-out (lib/realtime.ts): when this
      // session is revoked, exactly this socket is disconnected server-side.
      (socket.data as SocketData).sessionId = auth.sessionId;
      (socket.data as SocketData).conversationIds = new Set();
      nextFn();
    } catch (err) {
      nextFn(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    const { userId, username, displayName } = data;

    // Join the personal room immediately. All `socket.on(...)` handlers below
    // are registered SYNCHRONOUSLY — before any await — so events a client
    // emits in the same tick as 'connect' are never silently dropped (this
    // closes the latent dropped-offer race).
    socket.join(ROOM.user(userId));

    // Conversation room joins + presence run after handler registration
    // (fire-and-forget). Handlers that act on conversations re-check
    // membership per event, so early events are still safe.
    void (async () => {
      const memberships = await db.conversationMember.findMany({
        where: { userId, leftAt: null },
        select: { conversationId: true }
      });
      for (const m of memberships) {
        socket.join(ROOM.conversation(m.conversationId));
        data.conversationIds.add(m.conversationId);
      }

      // Presence: mark online + notify allowed viewers only
      await db.user.update({ where: { id: userId }, data: { isOnline: true } }).catch(() => {});
      await broadcastPresence(io, userId, true, null);
    })();

    // ── Typing indicators ──
    socket.on(EVENTS.TYPING_START, async (payload: { conversationId: string }) => {
      if (!payload?.conversationId) return;
      // Membership check before broadcasting
      const isMember = await db.conversationMember.findFirst({
        where: { conversationId: payload.conversationId, userId, leftAt: null }
      });
      if (!isMember) return;

      socket.to(ROOM.conversation(payload.conversationId)).emit(EVENTS.TYPING_START, {
        conversationId: payload.conversationId,
        userId,
        username,
        displayName
      });
    });

    socket.on(EVENTS.TYPING_STOP, async (payload: { conversationId: string }) => {
      if (!payload?.conversationId) return;
      const isMember = await db.conversationMember.findFirst({
        where: { conversationId: payload.conversationId, userId, leftAt: null }
      });
      if (!isMember) return;
      socket.to(ROOM.conversation(payload.conversationId)).emit(EVENTS.TYPING_STOP, {
        conversationId: payload.conversationId,
        userId,
        username,
        displayName
      });
    });

    // ── Delivery receipts (client acknowledges socket receipt of messages) ──
    socket.on(
      EVENTS.MESSAGE_DELIVERED,
      async (payload: { conversationId: string; messageId?: string }) => {
        if (!payload?.conversationId) return;
        const isMember = await db.conversationMember.findFirst({
          where: { conversationId: payload.conversationId, userId, leftAt: null }
        });
        if (!isMember) return;

        const deliveredAt = new Date();
        await db.conversationMember
          .updateMany({
            where: {
              conversationId: payload.conversationId,
              userId,
              OR: [{ lastDeliveredAt: null }, { lastDeliveredAt: { lt: deliveredAt } }]
            },
            data: { lastDeliveredAt: deliveredAt }
          })
          .catch(() => {});

        io.to(ROOM.conversation(payload.conversationId)).emit(EVENTS.MESSAGE_DELIVERED, {
          conversationId: payload.conversationId,
          userId,
          messageId: payload.messageId ?? null,
          deliveredAt: deliveredAt.toISOString()
        });
      }
    );

    // ── Read receipts ──
    // Reads are persisted EXCLUSIVELY over HTTP POST /api/conversations/[id]/read
    // (the authoritative path) — that route writes the cursor and broadcasts
    // MESSAGE_READ to the room exactly once. The client no longer emits
    // MESSAGE_READ on the socket; this avoids the old double persistence +
    // double broadcast. MESSAGE_READ remains a server→client broadcast event.

    // ── WebRTC call signaling (Phase 4A: server-authoritative state machine) ──
    // Caller identity is ALWAYS the authenticated socket user — client-supplied
    // "from" fields are ignored. Every event resolves its call through the
    // in-memory registry (src/lib/call-state.ts), which enforces participant
    // membership, roles and valid state transitions. The Call row is written
    // only after a registry transition succeeds, and replayed/duplicate
    // events or unknown call ids are harmless no-ops.

    registerGroupCallSocket(io, socket, { userId, username, displayName });

    socket.on(EVENTS.CALL_OFFER, async (payload: CallSignalPayload) => {
      const to = typeof payload?.to === 'string' ? payload.to : '';
      const type = payload?.type === 'VIDEO' ? 'VIDEO' : 'VOICE';
      if (!to || to === userId) return;

      // Valid target user.
      const callee = await db.user.findUnique({ where: { id: to }, select: { id: true } });
      if (!callee) return;

      // Block rules in either direction.
      const blocked = await db.blockedUser.findFirst({
        where: {
          OR: [{ blockerId: userId, blockedId: to }, { blockerId: to, blockedId: userId }]
        },
        select: { id: true }
      });
      if (blocked) return;

      // Relationship rule: caller and callee must share an active DIRECT
      // conversation (1-to-1 calls only).
      const membership = await db.conversationMember.findFirst({
        where: {
          userId,
          leftAt: null,
          conversation: { type: 'DIRECT', members: { some: { userId: to, leftAt: null } } }
        },
        select: { conversationId: true }
      });
      if (!membership) return;

      // A live group call occupies the user the same way a 1:1 call does.
      if (isUserInGroupCall(userId) || isUserInGroupCall(to)) {
        socket.emit(EVENTS.CALL_BUSY, {
          callId: null,
          from: userId,
          to,
          reason: isUserInGroupCall(userId) ? 'CALLER_BUSY' : 'CALLEE_BUSY'
        });
        return;
      }

      const begun = beginCall({
        callId: randomUUID(),
        conversationId: membership.conversationId,
        callerId: userId,
        calleeId: to,
        type,
        callerSocketId: socket.id
      });

      if (!begun.ok) {
        // Busy (caller or callee already in a call): dedicated realtime result
        // only — no Call row, so call-history semantics stay unchanged.
        if (begun.reason === 'CALLER_BUSY' || begun.reason === 'CALLEE_BUSY') {
          socket.emit(EVENTS.CALL_BUSY, {
            callId: null,
            from: userId,
            to,
            reason: begun.reason
          });
        }
        return;
      }

      const callId = begun.call.callId;

      if (!begun.deduped) {
        const row = await db.call
          .create({
            data: {
              id: callId,
              conversationId: membership.conversationId,
              callerId: userId,
              calleeId: to,
              type,
              status: 'RINGING'
            }
          })
          .catch(() => null);
        if (!row) {
          abortCall(callId); // keep the registry consistent with the DB
          return;
        }
      }
      // A deduped retry re-uses the existing row and re-signals both sides
      // with the authoritative callId (harmless for the receiver).

      io.to(ROOM.user(to)).emit(EVENTS.CALL_OFFER, {
        callId,
        from: userId,
        fromName: displayName,
        fromUsername: username,
        to,
        type,
        sdp: payload.sdp ?? null
      });
      socket.emit(EVENTS.CALL_OFFER, { callId, from: userId, to, type, outgoing: true });

      // Background devices only. A connected socket already gets the call screen.
      if (!begun.deduped) {
        const calleeSockets = await io.in(ROOM.user(to)).fetchSockets();
        if (calleeSockets.length === 0) {
          void pushIncomingCall({
            userId: to,
            callId,
            callerName: displayName,
            callKind: type
          }).catch(() => {});
        }
      }
    });

    socket.on(EVENTS.CALL_ACCEPT, async (payload: { callId: string; sdp?: RTCSessionDescriptionInit }) => {
      const callId = typeof payload?.callId === 'string' ? payload.callId : '';
      if (!callId) return;
      // Callee-only, RINGING-only; anything else is a safe no-op.
      const accepted = acceptCall({ callId, userId, socketId: socket.id });
      if (!accepted) return;

      await db.call
        .updateMany({ where: { id: callId, status: 'RINGING' }, data: { status: 'CONNECTED' } })
        .catch(() => {});

      // Answer routed to the caller (existing event shape) + echo to the
      // acceptor's own session (existing behavior).
      io.to(ROOM.user(accepted.callerId)).emit(EVENTS.CALL_ANSWER, {
        callId,
        sdp: payload.sdp ?? null,
        accepted: true
      });
      io.to(ROOM.user(userId)).emit(EVENTS.CALL_ANSWER, {
        callId,
        sdp: payload.sdp ?? null,
        accepted: true
      });
    });

    socket.on(EVENTS.CALL_ICE, (payload: CallSignalPayload) => {
      // Participants-only; the resolved call's real peer is the only target —
      // payload.to is never trusted for routing, so ICE cannot be injected
      // into someone else's call.
      const call = resolveCallFor(userId, { callId: payload?.callId, peerId: payload?.to });
      if (!call) return;
      const peer = otherParticipant(call, userId);
      if (!peer) return;
      io.to(ROOM.user(peer)).emit(EVENTS.CALL_ICE, {
        callId: call.callId, // always the authoritative id
        from: userId,
        to: peer,
        candidate: payload.candidate ?? null
      });
    });

    // Phase 4C: camera on/off state (signaling only). Forwarded to the real
    // peer of a live call so the receiving side can show a camera-off state
    // instead of a frozen/black video.
    socket.on(EVENTS.CALL_CAMERA, (payload: { callId: string; to?: string; videoEnabled?: boolean }) => {
      const call = resolveCallFor(userId, { callId: payload?.callId, peerId: payload?.to });
      if (!call) return; // only live RINGING/CONNECTED calls carry camera state
      const peer = otherParticipant(call, userId);
      if (!peer) return;
      io.to(ROOM.user(peer)).emit(EVENTS.CALL_CAMERA, {
        callId: call.callId,
        from: userId,
        to: peer,
        videoEnabled: payload?.videoEnabled === true
      });
    });

    // ICE restart for a call that is already CONNECTED. Participants only.
    // This does not create a Call row and cannot busy-out the live call.
    socket.on(EVENTS.CALL_RENEGOTIATE, (payload: { callId?: string; to?: string; sdp?: RTCSessionDescriptionInit | null }) => {
      const call = resolveCallFor(userId, { callId: payload?.callId, peerId: payload?.to });
      if (!call || call.phase !== 'CONNECTED') return;
      const peer = otherParticipant(call, userId);
      if (!peer || !payload?.sdp) return;
      io.to(ROOM.user(peer)).emit(EVENTS.CALL_RENEGOTIATE, {
        callId: call.callId,
        from: userId,
        to: peer,
        sdp: payload.sdp
      });
    });

    socket.on(EVENTS.CALL_REJECT, async (payload: { callId: string; to: string }) => {
      const call = resolveCallFor(userId, { callId: payload?.callId, peerId: payload?.to });
      // Recipient-only refusal of a RINGING call. The phase is checked BEFORE
      // concluding — a decline can never end an already-connected call.
      if (!call || call.calleeId !== userId) return;
      if (call.phase !== 'RINGING') return;
      const res = endCall({ callId: call.callId, userId, via: 'user' });
      if (!res || res.status !== 'DECLINED') return;
      await concludeCall(res, userId);
    });

    socket.on(EVENTS.CALL_END, async (payload: { callId: string; to: string; durationSec?: number }) => {
      // Any participant may end; durationSec from the client is IGNORED (the
      // server computes it from the accept time).
      const call = resolveCallFor(userId, { callId: payload?.callId, peerId: payload?.to });
      if (!call) return;
      const res = endCall({ callId: call.callId, userId, via: 'user' });
      if (!res) return;
      // Note: a callee ending a RINGING call is a refusal (status DECLINED) →
      // concludeCall signals it as CALL_REJECT, matching existing client UX.
      await concludeCall(res, userId);
    });

    // ── Client-side rejoin after creating/joining a conversation ──
    socket.on('conversation:join', async (payload: { conversationId: string }) => {
      if (!payload?.conversationId) return;
      const isMember = await db.conversationMember.findFirst({
        where: { conversationId: payload.conversationId, userId, leftAt: null }
      });
      if (!isMember) return;
      socket.join(ROOM.conversation(payload.conversationId));
      data.conversationIds.add(payload.conversationId);
    });

    // ── Ephemeral view state (open-chat suppression) ──
    // The client reports which conversation it is ACTIVELY looking at
    // (visible tab). Stored per socket in-process — no persistence — and used
    // by the HTTP notification path to skip notification-center rows for
    // conversations the recipient is already reading.
    socket.on(EVENTS.CONVERSATION_VIEWING, async (payload: { conversationId?: string }) => {
      const conversationId = payload?.conversationId;
      if (typeof conversationId !== 'string' || !conversationId) return;
      const isMember = await db.conversationMember.findFirst({
        where: { conversationId, userId, leftAt: null }
      });
      if (!isMember) return;
      setViewer(userId, socket.id, conversationId);
    });

    socket.on(EVENTS.CONVERSATION_IDLE, () => {
      clearViewer(userId, socket.id);
    });

    // ── Disconnect ──
    socket.on('disconnect', async () => {
      clearViewer(userId, socket.id);
      const remaining = await io.in(ROOM.user(userId)).fetchSockets();

      // Phase 4A call cleanup: a call this socket OWNS (placed or accepted
      // from this tab) ends immediately even when other tabs stay open;
      // otherwise the call ends only when the user's last socket goes away.
      await onGroupSocketDisconnect(io, socket.id, userId);

      const owned = findCallBySocketId(socket.id);
      const stranded = remaining.length === 0 ? getCallForUser(userId) : null;
      const doomed = owned ?? stranded;
      if (doomed) {
        const res = endCall({ callId: doomed.callId, userId, via: 'disconnect' });
        if (res) await concludeCall(res, userId);
      }

      // Only mark offline when the user has no other live sockets
      if (remaining.length > 0) return;

      const lastSeenAt = new Date();
      await db.user
        .update({ where: { id: userId }, data: { isOnline: false, lastSeenAt } })
        .catch(() => {});

      await broadcastPresence(io, userId, false, lastSeenAt);
    });
  });

  // Retention sweep (audit M-4): prune long-expired rows at boot + every 6h.
  void runRetentionSweep()
    .then((s) => console.log(`  [retention] boot sweep: ${JSON.stringify(s)}`))
    .catch(() => {});
  const retentionTimer = setInterval(() => {
    void runRetentionSweep().catch(() => {});
  }, 6 * 60 * 60 * 1000);
  retentionTimer.unref();

  server.listen(port, hostname, () => {
    console.log(`\n  ⚡ LINKUPCHAT ready on http://${hostname}:${port}\n`);
    if (dev) console.log(`  Realtime: Socket.IO attached at /socket.io\n`);
  });
}

start().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
