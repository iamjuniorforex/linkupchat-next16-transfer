import { db } from '@/lib/db';
import { withAuth, ok } from '@/lib/api';
import { archivedStatusWhere } from '@/lib/status-privacy';
import type { StatusDTO } from '@/types';

export const dynamic = 'force-dynamic';

/** Private archive for the author. Expired and archived rows only. */
export const GET = withAuth(async (_req, user) => {
  const statuses = await db.status.findMany({
    where: { AND: [archivedStatusWhere(), { userId: user.id }] },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { _count: { select: { views: true } } }
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
    archivedAt: s.archivedAt?.toISOString() ?? s.expiresAt.toISOString(),
    fontStyle: s.fontStyle,
    textColor: s.textColor,
    viewerCount: s._count.views
  }));

  return ok({ statuses: dto });
});
