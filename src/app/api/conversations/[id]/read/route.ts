import { db } from '@/lib/db';
import { withAuth, ok, readJson, ApiError } from '@/lib/api';
import { requireConversationAccess } from '@/lib/serialize';
import { emitToConversation } from '@/lib/realtime';
import { EVENTS } from '@shared/events';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const schema = z.object({
  messageId: z.string().optional()
});

/**
 * Mark a conversation as read up to a message (read receipts).
 *
 * AUTHORITATIVE read path: the client persists reads over this HTTP route
 * only (no socket MESSAGE_READ emit) so the cursor is written exactly once
 * and MESSAGE_READ is broadcast to the room exactly once. HTTP is preferred
 * over the socket because it is acknowledged, retries cleanly, and works
 * even when the realtime connection is momentarily down.
 *
 * Semantics ("read up to message"): the cursor advances to the marked
 * message's createdAt — never to `now` — so messages the user has not
 * actually seen stay unread. The cursor only moves forward.
 */
export const POST = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  await requireConversationAccess(user.id, id);
  const body = schema.parse(await readJson(req).catch(() => ({})));

  const member = await db.conversationMember.findFirst({
    where: { conversationId: id, userId: user.id },
    select: { lastReadAt: true }
  });
  if (!member) throw new ApiError('FORBIDDEN', 'You do not have access to this conversation.', 403);

  // Target cursor: the marked message's timestamp, or "everything" (now) when
  // no message is given.
  let readAt = new Date();
  let targetMessageId: string | null = body.messageId ?? null;
  if (body.messageId) {
    const msg = await db.message.findFirst({
      where: { id: body.messageId, conversationId: id },
      select: { createdAt: true }
    });
    if (!msg) throw new ApiError('NOT_FOUND', 'Message not found in this conversation.', 404);
    readAt = msg.createdAt;
  }

  // Forward-only cursor — repeated/older marks are no-ops.
  const shouldAdvance = !member.lastReadAt || readAt > member.lastReadAt;
  if (shouldAdvance) {
    await db.conversationMember.updateMany({
      where: { conversationId: id, userId: user.id },
      data: {
        lastReadAt: readAt,
        lastDeliveredAt: readAt,
        ...(targetMessageId ? { lastReadMessageId: targetMessageId } : {})
      }
    });
  } else {
    targetMessageId = null;
  }

  if (!shouldAdvance) return ok({ read: true, advanced: false });

  // Read-receipt privacy: record the read, but when disabled never announce
  // it (symmetric — the reader also cannot see others' read receipts).
  const settings = await db.userSettings
    .findUnique({ where: { userId: user.id }, select: { privacyReadReceipts: true } })
    .catch(() => null);
  if (settings?.privacyReadReceipts !== false) {
    emitToConversation(id, EVENTS.MESSAGE_READ, {
      conversationId: id,
      userId: user.id,
      messageId: targetMessageId,
      readAt: readAt.toISOString()
    });
  }

  return ok({ read: true, advanced: true });
});
