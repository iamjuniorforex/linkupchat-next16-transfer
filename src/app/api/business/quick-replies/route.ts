import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { accessFor } from '@/lib/billing';
import { entitlementsFor } from '@/lib/entitlements';
import { validateQuickReply } from '@/lib/business-rules';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  const rows = await db.quickReply.findMany({
    where: { userId: user.id },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
  });
  return ok({ replies: rows.map((row) => ({ id: row.id, title: row.title, body: row.body })) });
});

export const POST = withAuth(async (req, user) => {
  const access = await accessFor(user.id);
  if (!entitlementsFor(access.plan).includes('business.tools')) {
    throw new ApiError('FORBIDDEN', 'LINKUPCHAT Business is required.', 403);
  }
  const parsed = validateQuickReply(await req.json().catch(() => ({})));
  if (!parsed.ok) throw new ApiError('VALIDATION_ERROR', parsed.reason, 400);
  const count = await db.quickReply.count({ where: { userId: user.id } });
  if (count >= 20) throw new ApiError('VALIDATION_ERROR', 'Quick reply limit reached.', 400);
  const row = await db.quickReply.create({ data: { userId: user.id, ...parsed.value } });
  return ok({ reply: { id: row.id, title: row.title, body: row.body } }, { status: 201 });
});
