/**
 * Phase 4A — authoritative in-memory call state (signaling foundation).
 *
 * The Socket.IO server owns every call transition here; clients only request
 * transitions. This module is pure TypeScript (no DB, no sockets) so the state
 * machine is unit-testable. The `Call` database row is written by the server
 * AFTER a transition succeeds here, keeping persistence consistent with this
 * authoritative state.
 *
 * Invariants enforced:
 *  - at most one active call per user (RINGING or CONNECTED)
 *  - only call participants can act on a call
 *  - role rules: only the callee accepts/rejects; either side may end
 *  - invalid state transitions are rejected (null / error result)
 *  - duplicate/replayed requests are harmless (idempotent re-detection)
 *  - every RINGING call is covered by a 45s ring timer
 */

export type CallKind = 'VOICE' | 'VIDEO';
export type CallPhase = 'RINGING' | 'CONNECTED';

/** Final statuses written to `Call.status` (existing Prisma enum — no migration). */
export type CallOutcomeStatus = 'ENDED' | 'MISSED' | 'DECLINED' | 'CANCELLED';

/** Wire reason for CALL_END (existing event, optional field). */
export type CallEndReason = 'ENDED' | 'CANCELLED' | 'TIMEOUT' | 'DISCONNECTED';

/** How a call was concluded — drives outcome mapping. */
export type ConcludeVia = 'user' | 'disconnect' | 'timeout' | 'sweep';

export interface ActiveCall {
  callId: string;
  conversationId: string | null;
  callerId: string;
  calleeId: string;
  type: CallKind;
  phase: CallPhase;
  /** ms epoch */
  startedAt: number;
  /** ms epoch when accepted; null while ringing */
  connectedAt: number | null;
  /** the socket that placed the call (its death ends the call) */
  callerSocketId: string | null;
  /** the socket that accepted the call */
  calleeSocketId: string | null;
}

export interface CallOutcome {
  call: ActiveCall;
  status: CallOutcomeStatus;
  reason: CallEndReason;
  /** server-computed (connected duration); never client-supplied */
  durationSec: number;
}

/** 45-second ringing timeout (Phase 4A decision). */
export const DEFAULT_RING_TIMEOUT_MS = 45_000;

const calls = new Map<string, ActiveCall>();
const userToCall = new Map<string, string>();
const ringTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ringTimeoutMs = new Map<string, number>();

let ringTimeoutHandler: ((callId: string) => void) | null = null;

/** Server wires this to conclude calls whose ring timer expires. */
export function setOnRingTimeout(handler: (callId: string) => void) {
  ringTimeoutHandler = handler;
}

function remember(call: ActiveCall) {
  calls.set(call.callId, call);
  userToCall.set(call.callerId, call.callId);
  userToCall.set(call.calleeId, call.callId);
}

function forget(callId: string) {
  const call = calls.get(callId);
  if (!call) return;
  calls.delete(callId);
  if (userToCall.get(call.callerId) === callId) userToCall.delete(call.callerId);
  if (userToCall.get(call.calleeId) === callId) userToCall.delete(call.calleeId);
  const t = ringTimers.get(callId);
  if (t) clearTimeout(t);
  ringTimers.delete(callId);
  ringTimeoutMs.delete(callId);
}

function armRingTimer(call: ActiveCall, timeoutMs: number) {
  const t = setTimeout(() => {
    ringTimers.delete(call.callId);
    ringTimeoutHandler?.(call.callId);
  }, timeoutMs);
  // Never keep a process alive just for a ring timer.
  if (typeof t.unref === 'function') t.unref();
  ringTimers.set(call.callId, t);
  ringTimeoutMs.set(call.callId, timeoutMs);
}

export function getCall(callId: string): ActiveCall | null {
  return calls.get(callId) ?? null;
}

export function getCallForUser(userId: string): ActiveCall | null {
  const id = userToCall.get(userId);
  return id ? calls.get(id) ?? null : null;
}

export function otherParticipant(call: ActiveCall, userId: string): string | null {
  if (call.callerId === userId) return call.calleeId;
  if (call.calleeId === userId) return call.callerId;
  return null;
}

/**
 * Resolve the call a signaling event refers to. The result is ALWAYS a call
 * `userId` participates in — cross-user call ids can never resolve, so a
 * malicious client cannot inject signaling into someone else's call.
 *
 * `callId` wins when it names one of the user's calls; otherwise a pair
 * fallback finds the user's active call with `peerId` (tolerates the client's
 * temporary pre-echo ids and retried events without trusting them).
 */
export function resolveCallFor(
  userId: string,
  opts: { callId?: string | null; peerId?: string | null } = {}
): ActiveCall | null {
  const callId = typeof opts.callId === 'string' ? opts.callId : '';
  if (callId) {
    const c = calls.get(callId);
    if (c && (c.callerId === userId || c.calleeId === userId)) return c;
  }
  const peerId = typeof opts.peerId === 'string' ? opts.peerId : '';
  if (peerId) {
    const c = getCallForUser(userId);
    if (c && otherParticipant(c, userId) === peerId) return c;
  }
  return null;
}

/** True when this socket owns the call (placed or accepted it). */
export function findCallBySocketId(socketId: string): ActiveCall | null {
  for (const c of calls.values()) {
    if (c.callerSocketId === socketId || c.calleeSocketId === socketId) return c;
  }
  return null;
}

export type BeginResult =
  | { ok: true; call: ActiveCall; deduped: boolean }
  | { ok: false; reason: 'SELF_CALL' | 'CALLER_BUSY' | 'CALLEE_BUSY' };

/**
 * Start a RINGING call. Atomic check-and-set (single-threaded) so concurrent
 * attempts resolve deterministically: exactly one caller wins a given callee.
 *
 * A repeated offer from the same caller to the same callee while ringing is a
 * client retry: `deduped: true` with the EXISTING call (no second call).
 */
export function beginCall(args: {
  callId: string;
  conversationId: string | null;
  callerId: string;
  calleeId: string;
  type: CallKind;
  callerSocketId?: string | null;
  ringTimeoutMs?: number;
}): BeginResult {
  const { callId, conversationId, callerId, calleeId, type } = args;
  if (!callId || !callerId || !calleeId || callerId === calleeId) {
    return { ok: false, reason: 'SELF_CALL' };
  }

  // Retry of an already-ringing attempt between the same pair?
  const existing = getCallForUser(callerId);
  if (
    existing &&
    existing.phase === 'RINGING' &&
    existing.callerId === callerId &&
    existing.calleeId === calleeId
  ) {
    return { ok: true, call: existing, deduped: true };
  }

  if (getCallForUser(callerId)) return { ok: false, reason: 'CALLER_BUSY' };
  if (getCallForUser(calleeId)) return { ok: false, reason: 'CALLEE_BUSY' };

  const call: ActiveCall = {
    callId,
    conversationId,
    callerId,
    calleeId,
    type,
    phase: 'RINGING',
    startedAt: Date.now(),
    connectedAt: null,
    callerSocketId: args.callerSocketId ?? null,
    calleeSocketId: null
  };
  remember(call);
  armRingTimer(call, args.ringTimeoutMs ?? DEFAULT_RING_TIMEOUT_MS);
  return { ok: true, call, deduped: false };
}

/** Roll back a begin whose database write failed (registry ⇄ DB consistency). */
export function abortCall(callId: string) {
  forget(callId);
}

/** Callee accepts: RINGING → CONNECTED. Anyone else / any other state → null. */
export function acceptCall(args: {
  callId: string;
  userId: string;
  socketId?: string | null;
}): ActiveCall | null {
  const call = calls.get(args.callId);
  if (!call) return null;
  if (call.calleeId !== args.userId) return null; // caller cannot accept own call
  if (call.phase !== 'RINGING') return null; // duplicate accept / already ended
  call.phase = 'CONNECTED';
  call.connectedAt = Date.now();
  call.calleeSocketId = args.socketId ?? call.calleeSocketId;
  const t = ringTimers.get(call.callId);
  if (t) clearTimeout(t);
  ringTimers.delete(call.callId);
  return call;
}

/**
 * Conclude a call at the request of a participant (`via: 'user'`), a socket
 * death (`via: 'disconnect'`), the ring timer (`'timeout'`) or the stale
 * sweeper (`'sweep'`). Returns the outcome to persist and signal, or null when
 * the request is not a valid transition (wrong user, already concluded, …).
 *
 * Outcome map:
 *                      │ RINGING               │ CONNECTED
 *  ────────────────────┼───────────────────────┼──────────────────
 *  user (caller)       │ CANCELLED/CANCELLED   │ ENDED/ENDED
 *  user (callee)       │ DECLINED/CANCELLED    │ ENDED/ENDED
 *  disconnect (caller) │ CANCELLED/DISCONNECTED│ ENDED/DISCONNECTED
 *  disconnect (callee) │ MISSED/DISCONNECTED   │ ENDED/DISCONNECTED
 *  timeout / sweep     │ MISSED/TIMEOUT        │ ENDED/DISCONNECTED (sweep)
 */
export function endCall(args: {
  callId: string;
  userId: string;
  via: ConcludeVia;
}): CallOutcome | null {
  const call = calls.get(args.callId);
  if (!call) return null; // replayed/late events are harmless

  const isCaller = call.callerId === args.userId;
  const isCallee = call.calleeId === args.userId;

  if (args.via === 'user' || args.via === 'disconnect') {
    // Participant-only control.
    if (!isCaller && !isCallee) return null;
  }

  let status: CallOutcomeStatus;
  let reason: CallEndReason;

  if (call.phase === 'CONNECTED') {
    status = 'ENDED';
    reason = args.via === 'user' ? 'ENDED' : 'DISCONNECTED';
    if (args.via === 'timeout') return null; // timers never fire once connected
    if (args.via === 'sweep') reason = 'DISCONNECTED';
  } else {
    // RINGING
    if (args.via === 'timeout' || args.via === 'sweep') {
      status = 'MISSED';
      reason = 'TIMEOUT';
    } else if (args.via === 'disconnect') {
      status = isCaller ? 'CANCELLED' : 'MISSED';
      reason = 'DISCONNECTED';
    } else {
      // explicit participant action
      status = isCaller ? 'CANCELLED' : 'DECLINED';
      reason = 'CANCELLED';
    }
  }

  const durationSec =
    call.connectedAt != null ? Math.max(0, Math.floor((Date.now() - call.connectedAt) / 1000)) : 0;

  // Snapshot before teardown so callers can persist + signal.
  const snapshot: ActiveCall = { ...call };
  forget(call.callId);
  return { call: snapshot, status, reason, durationSec };
}

/**
 * Stale-call sweeper: force-concludes registry entries that somehow outlived
 * their timers (defence in depth). Returns outcomes the server must persist
 * and signal.
 */
export function sweepStaleCalls(
  now = Date.now(),
  maxRingMs = DEFAULT_RING_TIMEOUT_MS * 2 + 30_000,
  maxConnectedMs = 12 * 60 * 60 * 1000
): CallOutcome[] {
  const out: CallOutcome[] = [];
  for (const call of [...calls.values()]) {
    const age = now - (call.phase === 'RINGING' ? call.startedAt : call.connectedAt ?? call.startedAt);
    const stale = call.phase === 'RINGING' ? age > maxRingMs : age > maxConnectedMs;
    if (!stale) continue;
    const res = endCall({ callId: call.callId, userId: call.callerId, via: 'sweep' });
    if (res) out.push(res);
  }
  return out;
}

export function activeCallCount(): number {
  return calls.size;
}

export function activeCalls(): ActiveCall[] {
  return [...calls.values()].map((c) => ({ ...c }));
}

/** Test helper — drop all state (never used in production paths). */
export function resetCallState() {
  for (const id of [...calls.keys()]) forget(id);
  ringTimeoutHandler = null;
}
