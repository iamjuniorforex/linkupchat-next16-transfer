import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Remove a call from YOUR call history.
 *
 * The Call row is shared between both participants, so "deletion" is per-user
 * visibility: only your own hidden flag is set. The row (duration/status/
 * timestamps), the other participant's history, messages and notifications are
 * all left untouched. Non-participants get 404 (existence is never revealed).
 */
export const DELETE = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;

  const call = await db.call.findUnique({ where: { id } });
  if (!call) throw new ApiError('NOT_FOUND', 'Call not found.', 404);

  if (call.isGroup) {
    const participant = await db.callParticipant.findUnique({
      where: { callId_userId: { callId: id, userId: user.id } }
    });
    if (!participant) throw new ApiError('NOT_FOUND', 'Call not found.', 404);
    await db.callParticipant.update({ where: { id: participant.id }, data: { hiddenAt: new Date() } });
    return ok({ callId: id, hidden: true });
  }

  const data =
    call.callerId === user.id
      ? { hiddenForCallerAt: new Date() }
      : call.calleeId === user.id
        ? { hiddenForCalleeAt: new Date() }
        : null;
  // Not a participant: never delete or reveal another user's call record.
  if (!data) throw new ApiError('NOT_FOUND', 'Call not found.', 404);

  await db.call.update({ where: { id }, data });

  return ok({ callId: id, hidden: true });
});
