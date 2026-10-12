import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { requireConversationAccess } from '@/lib/serialize';
import { accessFor } from '@/lib/billing';
import { hasEntitlement } from '@/lib/entitlements';
import { isChatTheme } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  await requireConversationAccess(user.id, id);
  const row = await db.conversationTheme.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } }
  });
  return ok({ themeKey: row?.themeKey ?? 'default' });
});

export const PUT = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  await requireConversationAccess(user.id, id);
  const access = await accessFor(user.id);
  if (!hasEntitlement(access.plan, 'premium.chatTheme')) {
    throw new ApiError('FORBIDDEN', 'Chat themes are a Premium feature.', 403);
  }
  const body = await req.json().catch(() => ({}));
  if (!isChatTheme(body.themeKey)) throw new ApiError('VALIDATION_ERROR', 'Unknown chat theme.', 400);
  if (body.themeKey === 'default') {
    await db.conversationTheme.deleteMany({ where: { conversationId: id, userId: user.id } });
    return ok({ themeKey: 'default' });
  }
  await db.conversationTheme.upsert({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
    create: { conversationId: id, userId: user.id, themeKey: body.themeKey },
    update: { themeKey: body.themeKey }
  });
  return ok({ themeKey: body.themeKey });
});
