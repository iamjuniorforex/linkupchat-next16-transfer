import { db } from '@/lib/db';
import { withAuth, ok } from '@/lib/api';
import { activeStatusWhere } from '@/lib/status-privacy';
import type { StatusDTO } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * My active statuses (Phase 5B) — expired and deleted entries are excluded
 * server-side, newest first. Includes viewer counts for the owner's list.
 */
export const GET = withAuth(async (_req, user) => {
  const statuses = await db.status.findMany({
    where: { AND: [activeStatusWhere(), { userId: user.id }] },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { views: true } }
    }
  });

  const dto: StatusDTO[] = statuses.map((s) => ({
    id: s.id,
    userId: s.userId,
    type: s.type as 'TEXT' | 'IMAGE' | 'VIDEO',
    content: s.content,
    background: s.background,
    mediaUrl: s.mediaUrl,
    mediaThumb: s.mediaThumb,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    fontStyle: s.fontStyle,
    textColor: s.textColor,
    audience: s.audience,
    viewerCount: s._count.views
  }));

  return ok({ statuses: dto });
});
