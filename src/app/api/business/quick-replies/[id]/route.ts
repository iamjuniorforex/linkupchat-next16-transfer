import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const DELETE = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  const row = await db.quickReply.findFirst({ where: { id, userId: user.id } });
  if (!row) throw new ApiError('NOT_FOUND', 'Quick reply not found.', 404);
  await db.quickReply.delete({ where: { id } });
  return ok({ deleted: true });
});
