import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { emitToUser } from '@/lib/realtime';
import { loadStatusForViewer } from '@/lib/status-privacy';
import { EVENTS } from '@shared/events';

export const dynamic = 'force-dynamic';

/**
 * Record that I viewed a status.
 *
 * Phase 3: audience rules are enforced here too (EVERYONE / contacts-only /
 * private + blocks) — a status outside my audience answers the same 404 as a
 * missing one, so view receipts and STATUS_VIEWED events can never leak
 * statuses the author hid from me.
 */
export const POST = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;

  const loaded = await loadStatusForViewer(user.id, id);
  if (!loaded?.active) throw new ApiError('NOT_FOUND', 'Status not found.', 404);
  const status = loaded.status;
  // The author's own open does not count as a viewer.
  if (status.userId === user.id) return ok({ viewed: true, viewId: null });

  let viewId: string | null = null;
  try {
    const view = await db.statusView.upsert({
      where: { statusId_viewerId: { statusId: id, viewerId: user.id } },
      update: {},
      create: { statusId: id, viewerId: user.id }
    });
    viewId = view.id;
  } catch (err) {
    // Two viewers (or a strict-mode double post) can race the unique insert.
    if ((err as { code?: string }).code !== 'P2002') throw err;
    viewId =
      (
        await db.statusView.findUnique({
          where: { statusId_viewerId: { statusId: id, viewerId: user.id } },
          select: { id: true }
        })
      )?.id ?? null;
  }

  if (status.userId !== user.id) {
    emitToUser(status.userId, EVENTS.STATUS_VIEWED, {
      statusId: id,
      viewer: { id: user.id, displayName: user.displayName }
    });
  }

  return ok({ viewed: true, viewId });
});
