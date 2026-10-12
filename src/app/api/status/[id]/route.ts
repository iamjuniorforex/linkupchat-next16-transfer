import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { statusAudienceFor } from '@/lib/status-privacy';
import { emitToUsers } from '@/lib/realtime';
import { deleteStoredObject } from '@/lib/storage';
import { EVENTS } from '@shared/events';

export const dynamic = 'force-dynamic';

/** Delete my own status early (before the 24h expiry). */
export const DELETE = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;

  const status = await db.status.findUnique({ where: { id } });
  // Already-deleted (or never existed) → 404; expired-but-active stays
  // deletable so owners can clean up early.
  if (!status || status.deletedAt) throw new ApiError('NOT_FOUND', 'Status not found.', 404);
  if (status.userId !== user.id) throw new ApiError('FORBIDDEN', 'You can only delete your own status.', 403);

  await db.status.update({ where: { id }, data: { deletedAt: new Date() } });

  // Attachment lifecycle (same pattern as avatar replacement cleanup): only
  // an attachment that exclusively backs this status is cleaned up. Anything
  // still referenced elsewhere is left untouched.
  if (status.attachmentId) {
    const attachment = await db.attachment.findUnique({ where: { id: status.attachmentId } });
    if (attachment) {
      const referencedElsewhere =
        attachment.messageId !== null ||
        (await db.status.count({
          where: { attachmentId: attachment.id, id: { not: id }, deletedAt: null }
        })) > 0;
      if (!referencedElsewhere) {
        await db.attachment
          .delete({ where: { id: attachment.id } })
          .then(() => deleteStoredObject(attachment.storageKey))
          .catch(() => {});
      }
    }
  }

  // Let open clients drop it from rails/feeds without a refresh — contacts
  // (same audience as STATUS_NEW) plus the author's own devices.
  const { contactIds } = await statusAudienceFor(user.id);
  emitToUsers([...new Set([...contactIds, user.id])], EVENTS.STATUS_DELETED, {
    userId: user.id,
    displayName: user.displayName,
    statusId: status.id
  });

  return ok({ deleted: true });
});

/** Status detail incl. viewers (owner only). */
export const GET = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;

  const status = await db.status.findUnique({
    where: { id },
    include: {
      views: {
        include: {
          viewer: { select: { id: true, username: true, displayName: true, avatarUrl: true } }
        }
      }
    }
  });

  if (!status || status.deletedAt) throw new ApiError('NOT_FOUND', 'Status not found.', 404);
  if (status.userId !== user.id) throw new ApiError('NOT_FOUND', 'Status not found.', 404);

  return ok({
    status: {
      id: status.id,
      viewerCount: status.views.filter((v) => v.viewerId !== user.id).length,
      viewers: status.views.filter((v) => v.viewerId !== user.id).map((v) => ({
        ...v.viewer,
        viewedAt: v.viewedAt.toISOString()
      }))
    }
  });
});
