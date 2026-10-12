/**
 * Group-call signaling. Membership is checked on every operation. Media is
 * not forwarded through Socket.IO — only SDP/ICE between joined participants.
 */
import { randomUUID } from 'crypto';
import type { Server as IOServer, Socket } from 'socket.io';
import { db } from './db';
import { EVENTS, ROOM } from '../../shared/events';
import { getCallForUser } from './call-state';
import {
  abortGroupCall,
  acceptGroupCall,
  canExchangeSignal,
  declineGroupCall,
  expireGroupRejoin,
  expireGroupRing,
  findGroupCallBySocketId,
  isUserInGroupCall,
  leaveGroupCall,
  planGroupInvites,
  setGroupMediaState,
  setOnGroupRejoinExpired,
  setOnGroupRingTimeout,
  startGroupCall,
  sweepStaleGroupCalls,
  type GroupCall,
  type GroupCallOutcome
} from './group-call-state';
import { buildMissedCallData, buildMissedCallNotification, parseNotificationData } from './notifications';
import { getActiveViewers } from './realtime';
import { dispatchPush } from './push';
import { pushIncomingCall } from './call-notify';

type Person = { id: string; username: string; displayName: string; avatarUrl: string | null };

const profiles = new Map<string, Map<string, Person>>();

const ERRORS: Record<string, string> = {
  NOT_MEMBER: "You can't start a call in this group.",
  MESH_LIMIT:
    'Group calls connect directly and are limited to 4 people. Pick up to 3 people. Larger groups need a media server, which is not configured.',
  NO_RECIPIENTS: 'No one in this group can take the call right now.',
  NOT_ELIGIBLE: 'Choose people who are currently in this group.',
  HOST_BUSY: "You're already in a call.",
  INVITEE_BUSY: 'Someone you invited is already in a call.',
  ENDED: 'That call has ended.'
};

function emitTo(io: IOServer, userId: string, event: string, payload: unknown) {
  io.to(ROOM.user(userId)).emit(event, payload);
}

function fail(socket: Socket, code: string) {
  socket.emit(EVENTS.GROUP_CALL_ERROR, { code, message: ERRORS[code] ?? 'The call could not be started.' });
}

function person(callId: string, userId: string): Person | null {
  return profiles.get(callId)?.get(userId) ?? null;
}

function roster(call: GroupCall) {
  return call.participants
    .filter((p) => p.phase === 'JOINED')
    .map((p) => {
      const who = person(call.callId, p.userId);
      return who
        ? { ...who, muted: p.muted, cameraOff: p.cameraOff }
        : { id: p.userId, username: '', displayName: 'Participant', avatarUrl: null, muted: p.muted, cameraOff: p.cameraOff };
    });
}

async function cachePeople(callId: string, ids: string[]) {
  const missing = ids.filter((id) => !profiles.get(callId)?.has(id));
  if (missing.length === 0) return;
  const users = await db.user.findMany({
    where: { id: { in: missing } },
    select: { id: true, username: true, displayName: true, avatarUrl: true }
  });
  const bucket = profiles.get(callId) ?? new Map<string, Person>();
  for (const user of users) bucket.set(user.id, user);
  profiles.set(callId, bucket);
}

async function persistOutcome(io: IOServer, res: GroupCallOutcome, groupTitle: string | null) {
  await db.call
    .updateMany({
      where: { id: res.call.callId, OR: [{ status: 'RINGING' }, { status: 'CONNECTED' }] },
      data: { status: res.status, endedAt: new Date(), durationSec: res.durationSec }
    })
    .catch(() => {});

  for (const p of res.call.participants) {
    const status = p.phase === 'INVITED' ? 'MISSED' : p.phase === 'JOINED' ? 'LEFT' : p.phase;
    await db.callParticipant
      .updateMany({
        where: { callId: res.call.callId, userId: p.userId },
        data: { status, leftAt: new Date() }
      })
      .catch(() => {});
  }

  const ended = {
    callId: res.call.callId,
    reason: res.reason,
    durationSec: res.durationSec,
    status: res.status
  };
  for (const userId of res.notifyUserIds) emitTo(io, userId, EVENTS.GROUP_CALL_ENDED, ended);

  const host = person(res.call.callId, res.call.hostId);
  for (const userId of res.missedUserIds) {
    try {
      if (getActiveViewers(res.call.conversationId).includes(userId)) continue;
      const settings = await db.user.findUnique({
        where: { id: userId },
        select: { settings: { select: { notifCalls: true } } }
      });
      if (settings?.settings?.notifCalls === false) continue;
      const { title, body } = buildMissedCallNotification({
        callerName: host?.displayName ?? 'Someone',
        callKind: res.call.type,
        groupTitle
      });
      const row = await db.notification.create({
        data: {
          userId,
          type: 'CALL',
          title,
          body,
          data: buildMissedCallData({
            callId: res.call.callId,
            conversationId: res.call.conversationId,
            peerId: res.call.hostId,
            callKind: res.call.type
          })
        }
      });
      emitTo(io, userId, EVENTS.NOTIFICATION_NEW, {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        data: parseNotificationData(row.data),
        readAt: null,
        createdAt: row.createdAt.toISOString()
      });
      void dispatchPush({
        userId,
        kind: 'CALL',
        title: row.title,
        body: row.body ?? undefined,
        data: { url: '/app/calls' },
        tag: `call:${res.call.callId}`
      }).catch(() => {});
    } catch {
      // A notification failure must not change call conclusion.
    }
  }
  profiles.delete(res.call.callId);
}

async function groupTitle(conversationId: string): Promise<string | null> {
  const row = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { title: true }
  });
  return row?.title ?? null;
}

function broadcastJoined(io: IOServer, call: GroupCall, userId: string) {
  const payload = { callId: call.callId, userId, roster: roster(call), phase: call.phase };
  for (const p of call.participants) {
    if (p.phase === 'JOINED') emitTo(io, p.userId, EVENTS.GROUP_CALL_JOINED, payload);
  }
}

function broadcastPeer(io: IOServer, call: GroupCall, userId: string, phase: string) {
  const payload = { callId: call.callId, userId, phase };
  for (const p of call.participants) {
    if (p.phase === 'JOINED' && p.userId !== userId) emitTo(io, p.userId, EVENTS.GROUP_CALL_PEER, payload);
  }
}

export function installGroupCallRuntime(io: IOServer) {
  setOnGroupRingTimeout((callId) => {
    void (async () => {
      const res = expireGroupRing(callId);
      if (!res) return;
      await persistOutcome(io, res, await groupTitle(res.call.conversationId));
    })();
  });
  setOnGroupRejoinExpired((callId, userId) => {
    void (async () => {
      const ended = expireGroupRejoin(callId, userId);
      await db.callParticipant
        .updateMany({
          where: { callId, userId, status: { in: ['JOINED', 'LEFT'] } },
          data: { status: 'LEFT', leftAt: new Date() }
        })
        .catch(() => {});
      if (ended) await persistOutcome(io, ended, await groupTitle(ended.call.conversationId));
    })();
  });
  const timer = setInterval(() => {
    void (async () => {
      for (const res of sweepStaleGroupCalls()) {
        await persistOutcome(io, res, await groupTitle(res.call.conversationId));
      }
    })();
  }, 60_000);
  timer.unref();
}

export async function onGroupSocketDisconnect(io: IOServer, socketId: string, userId: string) {
  const owned = findGroupCallBySocketId(socketId);
  if (!owned) return;
  const mine = owned.participants.find((p) => p.userId === userId);
  if (!mine || mine.socketId !== socketId) return;
  const res = leaveGroupCall({ callId: owned.callId, userId, via: 'disconnect' });
  if (!res) return;
  if (res.ended) {
    await persistOutcome(io, res.ended, await groupTitle(owned.conversationId));
    return;
  }
  await db.callParticipant
    .updateMany({ where: { callId: owned.callId, userId }, data: { status: 'LEFT', leftAt: new Date() } })
    .catch(() => {});
  if (res.call) broadcastPeer(io, res.call, userId, 'LEFT');
}

export function registerGroupCallSocket(
  io: IOServer,
  socket: Socket,
  user: { userId: string; username: string; displayName: string }
) {
  const { userId } = user;

  socket.on(EVENTS.GROUP_CALL_START, async (payload: { conversationId?: string; type?: string; inviteeIds?: string[] }) => {
    const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : '';
    const type = payload?.type === 'VIDEO' ? 'VIDEO' : 'VOICE';
    if (!conversationId) return fail(socket, 'NOT_MEMBER');
    if (getCallForUser(userId) || isUserInGroupCall(userId)) {
      socket.emit(EVENTS.GROUP_CALL_BUSY, { reason: 'HOST_BUSY' });
      return fail(socket, 'HOST_BUSY');
    }

    const membership = await db.conversationMember.findFirst({
      where: { conversationId, userId, leftAt: null, conversation: { type: 'GROUP' } },
      select: { conversation: { select: { title: true, avatarUrl: true } } }
    });
    if (!membership) return fail(socket, 'NOT_MEMBER');

    const members = await db.conversationMember.findMany({
      where: { conversationId, leftAt: null },
      select: { userId: true }
    });
    const memberIds = members.map((m) => m.userId);
    const others = memberIds.filter((id) => id !== userId);
    const blocks = others.length
      ? await db.blockedUser.findMany({
          where: {
            OR: [
              { blockerId: userId, blockedId: { in: others } },
              { blockedId: userId, blockerId: { in: others } }
            ]
          },
          select: { blockerId: true, blockedId: true }
        })
      : [];
    const blockedIds = blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId));
    const busyIds = others.filter((id) => getCallForUser(id) || isUserInGroupCall(id));
    const requested = Array.isArray(payload?.inviteeIds) ? payload.inviteeIds.filter((id) => typeof id === 'string') : null;
    const plan = planGroupInvites({
      hostId: userId,
      memberIds,
      requestedIds: requested,
      blockedIds,
      busyIds
    });
    if (!plan.ok) return fail(socket, plan.reason);

    const begun = startGroupCall({
      callId: crypto.randomUUID(),
      conversationId,
      hostId: userId,
      inviteeIds: plan.inviteeIds,
      type,
      hostSocketId: socket.id
    });
    if (!begun.ok) return fail(socket, begun.reason === 'INVITEE_BUSY' ? 'INVITEE_BUSY' : 'HOST_BUSY');

    const call = begun.call;
    if (!begun.deduped) {
      const row = await db.call
        .create({
          data: {
            id: call.callId,
            conversationId,
            callerId: userId,
            calleeId: null,
            type,
            status: 'RINGING',
            isGroup: true,
            participants: {
              create: call.participants.map((p) => ({
                userId: p.userId,
                role: p.role,
                status: p.phase === 'JOINED' ? 'JOINED' : 'INVITED',
                joinedAt: p.phase === 'JOINED' ? new Date() : null
              }))
            }
          }
        })
        .catch(() => null);
      if (!row) {
        abortGroupCall(call.callId);
        return fail(socket, 'NOT_MEMBER');
      }
    }

    await cachePeople(call.callId, call.participants.map((p) => p.userId));
    const title = membership.conversation.title;
    const started = {
      callId: call.callId,
      conversationId,
      type,
      groupTitle: title,
      groupAvatar: membership.conversation.avatarUrl,
      host: person(call.callId, userId) ?? {
        id: userId,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: null
      },
      invitees: plan.inviteeIds.map((id) => person(call.callId, id)).filter(Boolean),
      skippedBusy: plan.skippedBusy
    };
    emitTo(io, userId, EVENTS.GROUP_CALL_STARTED, started);
    const ringing = call.participants.filter((p) => p.phase === 'INVITED').map((p) => p.userId);
    for (const id of ringing) {
      emitTo(io, id, EVENTS.GROUP_CALL_INVITE, {
        callId: call.callId,
        conversationId,
        type,
        groupTitle: title,
        groupAvatar: membership.conversation.avatarUrl,
        host: person(call.callId, userId)
      });
      if (!begun.deduped) {
        const live = await io.in(ROOM.user(id)).fetchSockets();
        if (live.length === 0) {
          void pushIncomingCall({
            userId: id,
            callId: call.callId,
            callerName: user.displayName,
            callKind: type,
            groupTitle: title
          }).catch(() => {});
        }
      }
    }
  });

  socket.on(EVENTS.GROUP_CALL_ACCEPT, async (payload: { callId?: string }) => {
    const callId = typeof payload?.callId === 'string' ? payload.callId : '';
    if (!callId) return;
    if (getCallForUser(userId)) return fail(socket, 'HOST_BUSY');
    const call = acceptGroupCall({ callId, userId, socketId: socket.id });
    if (!call) return;
    await db.callParticipant
      .updateMany({
        where: { callId, userId },
        data: { status: 'JOINED', joinedAt: new Date(), leftAt: null }
      })
      .catch(() => {});
    if (call.phase === 'CONNECTED') {
      await db.call
        .updateMany({ where: { id: callId, status: 'RINGING' }, data: { status: 'CONNECTED' } })
        .catch(() => {});
    }
    broadcastJoined(io, call, userId);
  });

  socket.on(EVENTS.GROUP_CALL_REJOIN, async (payload: { callId?: string }) => {
    const callId = typeof payload?.callId === 'string' ? payload.callId : '';
    if (!callId) return;
    const call = acceptGroupCall({ callId, userId, socketId: socket.id });
    if (!call) return fail(socket, 'ENDED');
    await db.callParticipant
      .updateMany({ where: { callId, userId }, data: { status: 'JOINED', leftAt: null } })
      .catch(() => {});
    broadcastJoined(io, call, userId);
  });

  socket.on(EVENTS.GROUP_CALL_DECLINE, async (payload: { callId?: string }) => {
    const callId = typeof payload?.callId === 'string' ? payload.callId : '';
    if (!callId) return;
    const res = declineGroupCall({ callId, userId });
    if (!res) return;
    await db.callParticipant
      .updateMany({ where: { callId, userId }, data: { status: 'DECLINED', leftAt: new Date() } })
      .catch(() => {});
    if (res.ended) {
      await persistOutcome(io, res.ended, await groupTitle(res.ended.call.conversationId));
      return;
    }
    broadcastPeer(io, res.call, userId, 'DECLINED');
  });

  socket.on(EVENTS.GROUP_CALL_LEAVE, async (payload: { callId?: string }) => {
    await endOrLeave(io, typeof payload?.callId === 'string' ? payload.callId : '', userId, false);
  });

  socket.on(EVENTS.GROUP_CALL_END, async (payload: { callId?: string }) => {
    await endOrLeave(io, typeof payload?.callId === 'string' ? payload.callId : '', userId, true);
  });

  socket.on(
    EVENTS.GROUP_CALL_SIGNAL,
    (payload: { callId?: string; to?: string; kind?: string; sdp?: unknown; candidate?: unknown; renegotiateRole?: string }) => {
      const callId = typeof payload?.callId === 'string' ? payload.callId : '';
      const to = typeof payload?.to === 'string' ? payload.to : '';
      const kind = payload?.kind;
      if (!callId || !to) return;
      if (kind !== 'offer' && kind !== 'answer' && kind !== 'ice' && kind !== 'renegotiate') return;
      if (!canExchangeSignal(callId, userId, to)) return;
      emitTo(io, to, EVENTS.GROUP_CALL_SIGNAL, {
        callId,
        from: userId,
        to,
        kind,
        sdp: payload.sdp ?? null,
        candidate: payload.candidate ?? null,
        renegotiateRole: payload.renegotiateRole === 'answer' ? 'answer' : 'offer'
      });
    }
  );

  socket.on(EVENTS.GROUP_CALL_STATE, async (payload: { callId?: string; muted?: boolean; cameraOff?: boolean }) => {
    const callId = typeof payload?.callId === 'string' ? payload.callId : '';
    if (!callId) return;
    const call = setGroupMediaState({
      callId,
      userId,
      muted: typeof payload?.muted === 'boolean' ? payload.muted : undefined,
      cameraOff: typeof payload?.cameraOff === 'boolean' ? payload.cameraOff : undefined
    });
    if (!call) return;
    await db.callParticipant
      .updateMany({
        where: { callId, userId },
        data: {
          ...(typeof payload?.muted === 'boolean' ? { muted: payload.muted } : {}),
          ...(typeof payload?.cameraOff === 'boolean' ? { cameraOff: payload.cameraOff } : {})
        }
      })
      .catch(() => {});
    const mine = call.participants.find((p) => p.userId === userId);
    for (const p of call.participants) {
      if (p.phase === 'JOINED' && p.userId !== userId) {
        emitTo(io, p.userId, EVENTS.GROUP_CALL_STATE, {
          callId,
          from: userId,
          muted: mine?.muted ?? false,
          cameraOff: mine?.cameraOff ?? false
        });
      }
    }
  });
}

async function endOrLeave(io: IOServer, callId: string, userId: string, asEnd: boolean) {
  if (!callId) return;
  const res = leaveGroupCall({ callId, userId, via: 'user' });
  if (!res) return;
  if (!asEnd && res.ended && res.ended.call.hostId !== userId) {
    // Member leave that finished the call is still a real end.
  }
  if (res.ended) {
    await persistOutcome(io, res.ended, await groupTitle(res.ended.call.conversationId));
    return;
  }
  await db.callParticipant
    .updateMany({ where: { callId, userId }, data: { status: 'LEFT', leftAt: new Date() } })
    .catch(() => {});
  if (res.call) broadcastPeer(io, res.call, userId, 'LEFT');
}
