import { db } from '@/lib/db';
import { withAuth, requireAdmin, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Platform statistics for the admin dashboard (Section 25). */
export const GET = withAuth(async (_req, user) => {
  requireAdmin(user);

  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  const [totalUsers, totalMessages, totalConversations, active24h, openReports, suspended, banned] =
    await Promise.all([
      db.user.count(),
      db.message.count(),
      db.conversation.count(),
      db.session.count({ where: { lastUsedAt: { gt: dayAgo } } }),
      db.report.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
      db.user.count({ where: { status: 'SUSPENDED' } }),
      db.user.count({ where: { status: 'BANNED' } })
    ]);

  return ok({
    totalUsers,
    totalMessages,
    totalConversations,
    activeSessions24h: active24h,
    openReports,
    suspended,
    banned
  });
});
