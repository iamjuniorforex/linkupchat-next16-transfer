/**
 * Group-call registry (Phase 14).
 *
 * Media is a peer-to-peer mesh on the existing CallEngine — one peer
 * connection per other joined participant, never a second 1:1 call system.
 * There is no media server in this app. Mesh bandwidth grows with every
 * extra person (each participant uploads N-1 streams), so a call is capped
 * at {@link MAX_MESH_PARTICIPANTS}. Larger groups need an SFU, which is not
 * configured and is not faked here.
 *
 * This module is pure (no DB, no sockets). The server authorizes membership
 * before calling in, then persists only after a transition succeeds.
 */

export const MAX_MESH_PARTICIPANTS = 4;
export const GROUP_RING_TIMEOUT_MS = 45_000;
/** How long a dropped participant may rejoin before the slot is released. */
export const GROUP_REJOIN_MS = 20_000;

export type GroupCallKind = 'VOICE' | 'VIDEO';
export type GroupParticipantPhase = 'INVITED' | 'JOINED' | 'LEFT' | 'DECLINED' | 'MISSED';
export type GroupRole = 'HOST' | 'MEMBER';

export interface GroupParticipant {
  userId: string;
  role: GroupRole;
  phase: GroupParticipantPhase;
  socketId: string | null;
  muted: boolean;
  cameraOff: boolean;
  /** Socket-death only. Explicit leave/decline cannot rejoin. */
  rejoinable: boolean;
}

export interface GroupCall {
  callId: string;
  conversationId: string;
  hostId: string;
  type: GroupCallKind;
  phase: 'RINGING' | 'CONNECTED';
  startedAt: number;
  connectedAt: number | null;
  participants: GroupParticipant[];
}

export interface GroupCallOutcome {
  call: GroupCall;
  status: 'ENDED' | 'MISSED' | 'CANCELLED';
  reason: 'ENDED' | 'CANCELLED' | 'TIMEOUT' | 'DISCONNECTED';
  durationSec: number;
  /** Invitees who never joined — they get the missed-call notification. */
  missedUserIds: string[];
  /** Everyone who should receive the terminal signal. */
  notifyUserIds: string[];
}

export type PlanInviteResult =
  | { ok: true; inviteeIds: string[]; skippedBusy: string[] }
  | { ok: false; reason: 'NOT_MEMBER' | 'NO_RECIPIENTS' | 'MESH_LIMIT' | 'NOT_ELIGIBLE' };

const calls = new Map<string, GroupCall>();
const userToCall = new Map<string, string>();
const ringTimers = new Map<string, ReturnType<typeof setTimeout>>();
const rejoinTimers = new Map<string, ReturnType<typeof setTimeout>>();

let ringTimeoutHandler: ((callId: string) => void) | null = null;
let rejoinExpiredHandler: ((callId: string, userId: string) => void) | null = null;

export function setOnGroupRingTimeout(handler: (callId: string) => void) {
  ringTimeoutHandler = handler;
}

export function setOnGroupRejoinExpired(handler: (callId: string, userId: string) => void) {
  rejoinExpiredHandler = handler;
}

function clone(call: GroupCall): GroupCall {
  return { ...call, participants: call.participants.map((p) => ({ ...p })) };
}

function remember(call: GroupCall) {
  calls.set(call.callId, call);
  for (const p of call.participants) {
    if (p.phase === 'INVITED' || p.phase === 'JOINED') userToCall.set(p.userId, call.callId);
  }
}

function syncBusy(call: GroupCall) {
  for (const p of call.participants) {
    const active = p.phase === 'INVITED' || p.phase === 'JOINED';
    if (active) userToCall.set(p.userId, call.callId);
    else if (userToCall.get(p.userId) === call.callId) userToCall.delete(p.userId);
  }
}

function clearTimers(callId: string) {
  const ring = ringTimers.get(callId);
  if (ring) clearTimeout(ring);
  ringTimers.delete(callId);
  for (const [key, timer] of rejoinTimers) {
    if (key.startsWith(`${callId}:`)) {
      clearTimeout(timer);
      rejoinTimers.delete(key);
    }
  }
}

function forget(callId: string) {
  const call = calls.get(callId);
  if (!call) return;
  calls.delete(callId);
  for (const p of call.participants) {
    if (userToCall.get(p.userId) === callId) userToCall.delete(p.userId);
  }
  clearTimers(callId);
}

function joinedCount(call: GroupCall): number {
  return call.participants.filter((p) => p.phase === 'JOINED').length;
}

function durationOf(call: GroupCall, now = Date.now()): number {
  if (call.connectedAt == null) return 0;
  return Math.max(0, Math.floor((now - call.connectedAt) / 1000));
}

function outcome(
  call: GroupCall,
  status: GroupCallOutcome['status'],
  reason: GroupCallOutcome['reason']
): GroupCallOutcome {
  const snapshot = clone(call);
  const missedUserIds = snapshot.participants
    .filter((p) => p.phase === 'MISSED' || p.phase === 'INVITED')
    .map((p) => p.userId);
  for (const p of snapshot.participants) {
    if (p.phase === 'INVITED') p.phase = 'MISSED';
  }
  return {
    call: snapshot,
    status,
    reason,
    durationSec: durationOf(call),
    missedUserIds,
    notifyUserIds: snapshot.participants.map((p) => p.userId)
  };
}

function maybeConnect(call: GroupCall) {
  if (call.phase === 'RINGING' && joinedCount(call) >= 2) {
    call.phase = 'CONNECTED';
    call.connectedAt = Date.now();
  }
}

/** End a call that has nobody left to talk to and nobody still ringing. */
function maybeFinish(call: GroupCall): GroupCallOutcome | null {
  const pending = call.participants.some((p) => p.phase === 'INVITED' || p.rejoinable);
  if (pending) return null;
  if (joinedCount(call) >= 2) return null;
  if (joinedCount(call) === 1 && call.phase === 'CONNECTED') {
    // One person left after others dropped for good. Don't leave them stuck.
    const res = outcome(call, 'ENDED', 'DISCONNECTED');
    forget(call.callId);
    return res;
  }
  if (joinedCount(call) <= 1 && call.phase === 'RINGING') {
    const res = outcome(call, 'CANCELLED', 'CANCELLED');
    forget(call.callId);
    return res;
  }
  if (joinedCount(call) === 0) {
    const res = outcome(call, call.connectedAt ? 'ENDED' : 'CANCELLED', call.connectedAt ? 'ENDED' : 'CANCELLED');
    forget(call.callId);
    return res;
  }
  return null;
}

function armRing(call: GroupCall, timeoutMs: number) {
  const timer = setTimeout(() => {
    ringTimers.delete(call.callId);
    ringTimeoutHandler?.(call.callId);
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  ringTimers.set(call.callId, timer);
}

function armRejoin(callId: string, userId: string) {
  const key = `${callId}:${userId}`;
  const prev = rejoinTimers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    rejoinTimers.delete(key);
    rejoinExpiredHandler?.(callId, userId);
  }, GROUP_REJOIN_MS);
  if (typeof timer.unref === 'function') timer.unref();
  rejoinTimers.set(key, timer);
}

export function isUserInGroupCall(userId: string): boolean {
  return userToCall.has(userId);
}

export function getGroupCall(callId: string): GroupCall | null {
  const call = calls.get(callId);
  return call ? clone(call) : null;
}

export function getGroupCallForUser(userId: string): GroupCall | null {
  const id = userToCall.get(userId);
  if (!id) return null;
  return getGroupCall(id);
}

export function findGroupCallBySocketId(socketId: string): GroupCall | null {
  for (const call of calls.values()) {
    if (call.participants.some((p) => p.socketId === socketId && (p.phase === 'JOINED' || p.role === 'HOST'))) {
      return clone(call);
    }
  }
  return null;
}

/**
 * Decide who may be invited. Membership and block lists are supplied by the
 * server after it has already checked the database — this function does not
 * trust a client id that is not in `memberIds`.
 */
export function planGroupInvites(args: {
  hostId: string;
  memberIds: string[];
  requestedIds?: string[] | null;
  blockedIds?: string[];
  busyIds?: string[];
}): PlanInviteResult {
  if (!args.memberIds.includes(args.hostId)) return { ok: false, reason: 'NOT_MEMBER' };
  const blocked = new Set(args.blockedIds ?? []);
  const busy = new Set(args.busyIds ?? []);
  const eligible = args.memberIds.filter((id) => id !== args.hostId && !blocked.has(id));

  let chosen: string[];
  if (args.requestedIds != null) {
    const requested = [...new Set(args.requestedIds.filter((id) => id && id !== args.hostId))];
    if (requested.length === 0) return { ok: false, reason: 'NO_RECIPIENTS' };
    if (requested.length > MAX_MESH_PARTICIPANTS - 1) return { ok: false, reason: 'MESH_LIMIT' };
    if (requested.some((id) => !eligible.includes(id))) return { ok: false, reason: 'NOT_ELIGIBLE' };
    chosen = requested;
  } else if (eligible.length > MAX_MESH_PARTICIPANTS - 1) {
    return { ok: false, reason: 'MESH_LIMIT' };
  } else {
    chosen = eligible;
  }

  const skippedBusy = chosen.filter((id) => busy.has(id));
  const inviteeIds = chosen.filter((id) => !busy.has(id));
  if (inviteeIds.length === 0) return { ok: false, reason: 'NO_RECIPIENTS' };
  return { ok: true, inviteeIds, skippedBusy };
}

/** Lower id creates the offer so two peers never glare. */
export function meshShouldOffer(localUserId: string, remoteUserId: string): boolean {
  return localUserId < remoteUserId;
}

export function canExchangeSignal(callId: string, fromUserId: string, toUserId: string): boolean {
  const call = calls.get(callId);
  if (!call || !fromUserId || !toUserId || fromUserId === toUserId) return false;
  const from = call.participants.find((p) => p.userId === fromUserId);
  const to = call.participants.find((p) => p.userId === toUserId);
  return !!from && !!to && from.phase === 'JOINED' && to.phase === 'JOINED';
}

export type StartGroupResult =
  | { ok: true; call: GroupCall; deduped: boolean }
  | { ok: false; reason: 'MESH_LIMIT' | 'HOST_BUSY' | 'INVITEE_BUSY' | 'EMPTY' };

export function startGroupCall(args: {
  callId: string;
  conversationId: string;
  hostId: string;
  inviteeIds: string[];
  type: GroupCallKind;
  hostSocketId?: string | null;
  ringTimeoutMs?: number;
}): StartGroupResult {
  const inviteeIds = [...new Set(args.inviteeIds.filter((id) => id && id !== args.hostId))];
  if (inviteeIds.length === 0) return { ok: false, reason: 'EMPTY' };
  if (inviteeIds.length > MAX_MESH_PARTICIPANTS - 1) return { ok: false, reason: 'MESH_LIMIT' };
  if (isUserInGroupCall(args.hostId)) {
    const existing = calls.get(userToCall.get(args.hostId)!);
    if (
      existing &&
      existing.phase === 'RINGING' &&
      existing.hostId === args.hostId &&
      existing.conversationId === args.conversationId
    ) {
      return { ok: true, call: clone(existing), deduped: true };
    }
    return { ok: false, reason: 'HOST_BUSY' };
  }
  if (inviteeIds.some((id) => isUserInGroupCall(id))) return { ok: false, reason: 'INVITEE_BUSY' };

  const call: GroupCall = {
    callId: args.callId,
    conversationId: args.conversationId,
    hostId: args.hostId,
    type: args.type,
    phase: 'RINGING',
    startedAt: Date.now(),
    connectedAt: null,
    participants: [
      {
        userId: args.hostId,
        role: 'HOST',
        phase: 'JOINED',
        socketId: args.hostSocketId ?? null,
        muted: false,
        cameraOff: false,
        rejoinable: false
      },
      ...inviteeIds.map((userId) => ({
        userId,
        role: 'MEMBER' as const,
        phase: 'INVITED' as const,
        socketId: null,
        muted: false,
        cameraOff: false,
        rejoinable: false
      }))
    ]
  };
  remember(call);
  armRing(call, args.ringTimeoutMs ?? GROUP_RING_TIMEOUT_MS);
  return { ok: true, call: clone(call), deduped: false };
}

export function abortGroupCall(callId: string) {
  forget(callId);
}

export function acceptGroupCall(args: {
  callId: string;
  userId: string;
  socketId?: string | null;
}): GroupCall | null {
  const call = calls.get(args.callId);
  if (!call) return null;
  const participant = call.participants.find((p) => p.userId === args.userId);
  if (!participant || participant.role === 'HOST') return null;
  if (participant.phase === 'JOINED') {
    participant.socketId = args.socketId ?? participant.socketId;
    return clone(call);
  }
  if (participant.phase !== 'INVITED' && !(participant.phase === 'LEFT' && participant.rejoinable)) return null;
  if (joinedCount(call) >= MAX_MESH_PARTICIPANTS) return null;
  participant.phase = 'JOINED';
  participant.socketId = args.socketId ?? participant.socketId;
  participant.rejoinable = false;
  const rejoin = rejoinTimers.get(`${call.callId}:${args.userId}`);
  if (rejoin) clearTimeout(rejoin);
  rejoinTimers.delete(`${call.callId}:${args.userId}`);
  maybeConnect(call);
  syncBusy(call);
  if (!call.participants.some((p) => p.phase === 'INVITED')) {
    const ring = ringTimers.get(call.callId);
    if (ring) clearTimeout(ring);
    ringTimers.delete(call.callId);
  }
  return clone(call);
}

export function declineGroupCall(args: { callId: string; userId: string }): {
  call: GroupCall;
  ended: GroupCallOutcome | null;
} | null {
  const call = calls.get(args.callId);
  if (!call) return null;
  const participant = call.participants.find((p) => p.userId === args.userId);
  if (!participant || participant.phase !== 'INVITED') return null;
  participant.phase = 'DECLINED';
  participant.rejoinable = false;
  syncBusy(call);
  const ended = maybeFinish(call);
  return { call: clone(calls.get(call.callId) ?? call), ended };
}

export function leaveGroupCall(args: {
  callId: string;
  userId: string;
  via: 'user' | 'disconnect';
}): { call: GroupCall | null; ended: GroupCallOutcome | null } | null {
  const call = calls.get(args.callId);
  if (!call) return null;
  const participant = call.participants.find((p) => p.userId === args.userId);
  if (!participant) return null;
  if (participant.phase !== 'JOINED' && participant.role !== 'HOST') return null;

  if (args.via === 'user' && participant.role === 'HOST') {
    const ended = outcome(call, call.connectedAt ? 'ENDED' : 'CANCELLED', 'ENDED');
    forget(call.callId);
    return { call: null, ended };
  }

  if (args.via === 'disconnect' && participant.phase === 'JOINED') {
    if (call.phase === 'RINGING' && participant.role === 'HOST' && joinedCount(call) <= 1) {
      const ended = outcome(call, 'CANCELLED', 'DISCONNECTED');
      forget(call.callId);
      return { call: null, ended };
    }
    participant.phase = 'LEFT';
    participant.rejoinable = true;
    participant.socketId = null;
    syncBusy(call);
    armRejoin(call.callId, args.userId);
    return { call: clone(call), ended: null };
  }

  participant.phase = 'LEFT';
  participant.rejoinable = false;
  participant.socketId = null;
  syncBusy(call);
  const ended = maybeFinish(call);
  return { call: calls.has(call.callId) ? clone(call) : null, ended };
}

export function expireGroupRejoin(callId: string, userId: string): GroupCallOutcome | null {
  const call = calls.get(callId);
  if (!call) return null;
  const participant = call.participants.find((p) => p.userId === userId);
  if (!participant || !participant.rejoinable) return null;
  participant.rejoinable = false;
  syncBusy(call);
  return maybeFinish(call);
}

export function expireGroupRing(callId: string): GroupCallOutcome | null {
  const call = calls.get(callId);
  if (!call || call.phase !== 'RINGING') return null;
  for (const p of call.participants) {
    if (p.phase === 'INVITED') p.phase = 'MISSED';
  }
  syncBusy(call);
  if (joinedCount(call) >= 2) return null;
  const ended = outcome(call, 'MISSED', 'TIMEOUT');
  forget(callId);
  return ended;
}

export function setGroupMediaState(args: {
  callId: string;
  userId: string;
  muted?: boolean;
  cameraOff?: boolean;
}): GroupCall | null {
  const call = calls.get(args.callId);
  if (!call) return null;
  const participant = call.participants.find((p) => p.userId === args.userId);
  if (!participant || participant.phase !== 'JOINED') return null;
  if (typeof args.muted === 'boolean') participant.muted = args.muted;
  if (typeof args.cameraOff === 'boolean') participant.cameraOff = args.cameraOff;
  return clone(call);
}

export function groupHistoryStatus(
  participantStatus: GroupParticipantPhase,
  callStatus: 'RINGING' | 'CONNECTED' | 'ENDED' | 'MISSED' | 'DECLINED' | 'CANCELLED' | 'FAILED'
): 'RINGING' | 'CONNECTED' | 'ENDED' | 'MISSED' | 'DECLINED' | 'CANCELLED' | 'FAILED' {
  if (participantStatus === 'MISSED') return 'MISSED';
  if (participantStatus === 'DECLINED') return 'DECLINED';
  if (participantStatus === 'INVITED') return callStatus === 'RINGING' ? 'RINGING' : 'MISSED';
  return callStatus;
}

/** Force-conclude registry entries that outlived their timers. */
export function sweepStaleGroupCalls(now = Date.now()): GroupCallOutcome[] {
  const out: GroupCallOutcome[] = [];
  for (const call of [...calls.values()]) {
    if (call.phase === 'RINGING' && now - call.startedAt > GROUP_RING_TIMEOUT_MS * 2) {
      const res = expireGroupRing(call.callId);
      if (res) out.push(res);
      continue;
    }
    const anchor = call.connectedAt ?? call.startedAt;
    if (call.phase === 'CONNECTED' && now - anchor > 12 * 60 * 60 * 1000) {
      const ended = outcome(call, 'ENDED', 'DISCONNECTED');
      forget(call.callId);
      out.push(ended);
    }
  }
  return out;
}

export function resetGroupCallState() {
  for (const id of [...calls.keys()]) forget(id);
  ringTimeoutHandler = null;
  rejoinExpiredHandler = null;
}
