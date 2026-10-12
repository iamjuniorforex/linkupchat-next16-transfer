import { db } from '@/lib/db';
import { withAuth, ok, readJson } from '@/lib/api';
import { requireConversationAccess } from '@/lib/serialize';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const schema = z.object({ muted: z.boolean() });

/** Mute/unmute a conversation for the current user. */
export const POST = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  await requireConversationAccess(user.id, id);
  const body = schema.parse(await readJson(req));

  await db.conversationMember.updateMany({
    where: { conversationId: id, userId: user.id },
    data: {
      isMuted: body.muted,
      mutedUntil: body.muted ? new Date(Date.now() + 365 * 24 * 3600_000) : null
    }
  });

  return ok({ muted: body.muted });
});
