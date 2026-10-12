import { db } from '@/lib/db';
import { withAuth, ok } from '@/lib/api';
import { groupHistoryStatus } from '@/lib/group-call-state';
import type { CallRecordDTO, CallStatus } from '@/types';

export const dynamic = 'force-dynamic';

/** Call history (Section 14), including group calls the user was part of. */
export const GET = withAuth(async (_req, user) => {
  const calls = await db.call.findMany({
    where: {
      OR: [
        { isGroup: false, callerId: user.id, hiddenForCallerAt: null },
        { isGroup: false, calleeId: user.id, hiddenForCalleeAt: null },
        { isGroup: true, participants: { some: { userId: user.id, hiddenAt: null } } }
      ]
    },
    orderBy: { startedAt: 'desc' },
    take: 50,
    include: {
      caller: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      callee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      conversation: { select: { title: true, avatarUrl: true } },
      participants: { select: { userId: true, role: true, status: true } }
    }
  });

  const dto: CallRecordDTO[] = [];
  for (const c of calls) {
    if (c.isGroup) {
      const me = c.participants.find((p) => p.userId === user.id);
      if (!me) continue;
      const title = c.conversation?.title?.trim() || 'Group call';
      dto.push({
        id: c.id,
        type: c.type,
        status: groupHistoryStatus(me.status, c.status) as CallStatus,
        startedAt: c.startedAt.toISOString(),
        endedAt: c.endedAt?.toISOString() ?? null,
        durationSec: c.durationSec,
        direction: me.role === 'HOST' ? 'OUTGOING' : 'INCOMING',
        peer: {
          id: c.conversationId ?? c.id,
          username: '',
          displayName: title,
          avatarUrl: c.conversation?.avatarUrl ?? null
        },
        conversationId: c.conversationId,
        isGroup: true,
        participantCount: c.participants.length
      });
      continue;
    }
    const peer = c.callerId === user.id ? c.callee : c.caller;
    if (!peer) continue;
    dto.push({
      id: c.id,
      type: c.type,
      status: c.status,
      startedAt: c.startedAt.toISOString(),
      endedAt: c.endedAt?.toISOString() ?? null,
      durationSec: c.durationSec,
      direction: c.callerId === user.id ? 'OUTGOING' : 'INCOMING',
      peer,
      conversationId: c.conversationId,
      isGroup: false
    });
  }

  return ok({ calls: dto });
});
