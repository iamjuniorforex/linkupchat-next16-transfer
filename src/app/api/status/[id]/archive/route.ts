import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { statusAudienceFor } from '@/lib/status-privacy';
import { emitToUsers } from '@/lib/realtime';
import { EVENTS } from '@shared/events';

export const dynamic = 'force-dynamic';

/** Hide an active status from feeds and keep it in the author's archive. */
export const POST = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  const status = await db.status.findUnique({ where: { id } });
  if (!status || status.deletedAt) throw new ApiError('NOT_FOUND', 'Status not found.', 404);
  if (status.userId !== user.id) throw new ApiError('FORBIDDEN', 'You can only archive your own status.', 403);
  if (!status.archivedAt) {
    await db.status.update({ where: { id }, data: { archivedAt: new Date() } });
  }
  const { contactIds } = await statusAudienceFor(user.id);
  emitToUsers([...new Set([...contactIds, user.id])], EVENTS.STATUS_DELETED, {
    userId: user.id,
    displayName: user.displayName,
    statusId: status.id
  });
  return ok({ archived: true });
});
