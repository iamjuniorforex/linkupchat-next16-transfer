import { db } from '@/lib/db';
import { withAuth, ok, readJson, ApiError } from '@/lib/api';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { statusReactionSchema } from '@/lib/validation';
import { loadStatusForViewer } from '@/lib/status-privacy';
import { isStatusEmoji, nextReaction } from '@/lib/status-stories';
import { notifyStatusReaction } from '@/lib/status-notify';
import { emitToUser } from '@/lib/realtime';
import { EVENTS } from '@shared/events';

export const dynamic = 'force-dynamic';

/** One reaction per viewer. Sending the same emoji again clears it. */
export const POST = withAuth(async (req, user, ctx) => {
  enforceUserRateLimit(user.id, 'status:react', 60);
  const { id } = (ctx as { params: { id: string } }).params;
  const body = statusReactionSchema.parse(await readJson(req));
  if (!isStatusEmoji(body.emoji)) {
    throw new ApiError('VALIDATION_ERROR', 'That reaction is not available.', 422);
  }

  const loaded = await loadStatusForViewer(user.id, id);
  if (!loaded?.active) throw new ApiError('NOT_FOUND', 'Status not found.', 404);

  const existing = await db.statusReaction.findUnique({
    where: { statusId_userId: { statusId: id, userId: user.id } }
  });
  const emoji = nextReaction(existing?.emoji ?? null, body.emoji);

  if (!emoji) {
    if (existing) await db.statusReaction.delete({ where: { id: existing.id } });
  } else if (existing) {
    await db.statusReaction.update({ where: { id: existing.id }, data: { emoji } });
  } else {
    await db.statusReaction.create({ data: { statusId: id, userId: user.id, emoji } });
  }

  if (emoji && emoji !== existing?.emoji) {
    const full = await db.status.findUnique({ where: { id }, select: { content: true, userId: true } });
    if (full && full.userId !== user.id) {
      await notifyStatusReaction({
        authorId: full.userId,
        reactorId: user.id,
        reactorName: user.displayName,
        statusId: id,
        emoji,
        statusText: full.content
      });
      emitToUser(full.userId, EVENTS.STATUS_REACTED, { statusId: id, emoji, userId: user.id });
    }
  }

  return ok({ emoji });
});
