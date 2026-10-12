/**
 * Realtime bridge — API route handlers emit socket events through this
 * module. When the app runs on the custom server (server.ts), the Socket.IO
 * instance is registered on globalThis by the realtime layer, so HTTP
 * handlers and WebSocket events stay in the same process.
 */
import type { Server as IOServer } from 'socket.io';
import { ROOM } from '@shared/events';

export function getIO(): IOServer | null {
  return ((globalThis as Record<string, unknown>).__LINKUP_IO as IOServer | undefined) ?? null;
}

export function emitToConversation(conversationId: string, event: string, payload: unknown) {
  getIO()?.to(ROOM.conversation(conversationId)).emit(event, payload);
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  getIO()?.to(ROOM.user(userId)).emit(event, payload);
}

export function emitToUsers(userIds: string[], event: string, payload: unknown) {
  const io = getIO();
  if (!io) return;
  for (const id of userIds) io.to(ROOM.user(id)).emit(event, payload);
}

export async function isUserOnline(userId: string): Promise<boolean> {
  const io = getIO();
  if (!io) return false;
  const sockets = await io.in(ROOM.user(userId)).fetchSockets();
  return sockets.length > 0;
}

/**
 * Join all of a user's live sockets to a conversation room (membership
 * granted). Pairs with removeUserFromConversation for instant access changes.
 */
export function joinUserToConversation(userId: string, conversationId: string) {
  getIO()?.in(ROOM.user(userId)).socketsJoin(ROOM.conversation(conversationId));
}

/**
 * Evict all of a user's live sockets from a conversation room (membership
 * revoked) — the removed member stops receiving realtime events immediately.
 */
export function removeUserFromConversation(userId: string, conversationId: string) {
  getIO()?.in(ROOM.user(userId)).socketsLeave(ROOM.conversation(conversationId));
}

// ── Session revocation fan-out ─────────────────────────────────────────────
// Every live socket carries its authenticated session id (bound at connect in
// server.ts). When a session is revoked through the API (logout, password
// change/reset, session revocation, suspend/ban), the revocation sites call
// these helpers so the matching sockets are disconnected SERVER-SIDE — they
// stop receiving message/notification/typing/call events immediately, and a
// voluntary client reconnect is refused by the auth middleware because the
// session is already revoked. Sockets for the user's other valid sessions
// are untouched.

type SocketSessionData = { userId?: string; sessionId?: string };

/** Disconnect every live socket bound to one of these session ids. */
export function disconnectSocketsForSessions(sessionIds: string[]): number {
  const io = getIO();
  if (!io || sessionIds.length === 0) return 0;
  const doomed = new Set(sessionIds);
  let disconnected = 0;
  for (const socket of io.sockets.sockets.values()) {
    const data = socket.data as SocketSessionData;
    if (data?.sessionId && doomed.has(data.sessionId)) {
      socket.disconnect(true);
      disconnected += 1;
    }
  }
  return disconnected;
}

/**
 * Disconnect every live socket for a user. `keepSessionIds` spares the
 * sockets of sessions that were intentionally NOT revoked (e.g.
 * "sign out other devices" keeps the current session alive).
 */
export function disconnectUserSockets(userId: string, opts?: { keepSessionIds?: string[] }): number {
  const io = getIO();
  if (!io) return 0;
  const keep = new Set(opts?.keepSessionIds ?? []);
  let disconnected = 0;
  for (const socket of io.sockets.sockets.values()) {
    const data = socket.data as SocketSessionData;
    if (data?.userId !== userId) continue;
    if (data?.sessionId && keep.has(data.sessionId)) continue;
    socket.disconnect(true);
    disconnected += 1;
  }
  return disconnected;
}

// ── Ephemeral "actively viewing a conversation" registry ──────────────────
// Backed by globalThis (same reasoning as __LINKUP_IO) so the HTTP handlers
// and the Socket.IO event handlers share one store in this process. Holds no
// durable state — cleared per socket on idle/disconnect. Used to suppress
// notification-center rows for conversations the recipient is looking at
// (server-side decision → feed/counters stay consistent).
type ViewerStore = Map<string, Map<string, string>>; // userId -> socketId -> conversationId

function viewerStore(): ViewerStore {
  const g = globalThis as Record<string, unknown>;
  if (!g.__LINKUP_ACTIVE_VIEWS) g.__LINKUP_ACTIVE_VIEWS = new Map();
  return g.__LINKUP_ACTIVE_VIEWS as ViewerStore;
}

/** Record that `socketId` (authenticated as `userId`) is viewing `conversationId`. */
export function setViewer(userId: string, socketId: string, conversationId: string) {
  const store = viewerStore();
  let perUser = store.get(userId);
  if (!perUser) {
    perUser = new Map();
    store.set(userId, perUser);
  }
  perUser.set(socketId, conversationId);
}

/** A socket stopped viewing (idle, switched conversation, or disconnected). */
export function clearViewer(userId: string, socketId: string) {
  const store = viewerStore();
  const perUser = store.get(userId);
  if (!perUser) return;
  perUser.delete(socketId);
  if (perUser.size === 0) store.delete(userId);
}

/** Users with at least one live socket actively viewing this conversation. */
export function getActiveViewers(conversationId: string): string[] {
  const out: string[] = [];
  for (const [userId, perUser] of viewerStore()) {
    for (const conv of perUser.values()) {
      if (conv === conversationId) {
        out.push(userId);
        break;
      }
    }
  }
  return out;
}
