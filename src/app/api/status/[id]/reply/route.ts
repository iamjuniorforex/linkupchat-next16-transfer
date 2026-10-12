import { db } from '@/lib/db';
import { withAuth, ok, readJson, ApiError } from '@/lib/api';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { statusReplySchema } from '@/lib/validation';
import { loadStatusForViewer } from '@/lib/status-privacy';
import { statusReplyContent } from '@/lib/status-stories';
import { notifyStatusReply } from '@/lib/status-notify';
import { assertNotBlocked, messageInclude, serializeMessage } from '@/lib/serialize';
import { emitToConversation, emitToUser, getActiveViewers } from '@/lib/realtime';
import { EVENTS } from '@shared/events';

export const dynamic = 'force-dynamic';

async function directConversationId(userId: string, peerId: string): Promise<string> {
  const directKey = [userId, peerId].sort().join(':');
  const existing = await db.conversation.findUnique({ where: { directKey }, select: { id: true } });
  if (existing) return existing.id;
  try {
    const created = await db.conversation.create({
      data: {
        type: 'DIRECT',
        directKey,
        createdBy: userId,
        members: { create: [{ userId }, { userId: peerId }] }
      },
      select: { id: true }
    });
    return created.id;
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const winner = await db.conversation.findUnique({ where: { directKey }, select: { id: true } });
    if (!winner) throw err;
    return winner.id;
  }
}

/** Reply through the existing direct chat, attributed to the status. */
export const POST = withAuth(async (req, user, ctx) => {
  enforceUserRateLimit(user.id, 'status:reply', 30);
  const { id } = (ctx as { params: { id: string } }).params;
  const body = statusReplySchema.parse(await readJson(req));

  const loaded = await loadStatusForViewer(user.id, id);
  if (!loaded?.active) throw new ApiError('NOT_FOUND', 'Status not found.', 404);
  if (loaded.status.userId === user.id) {
    throw new ApiError('VALIDATION_ERROR', 'You cannot reply to your own status.', 422);
  }
  await assertNotBlocked(user.id, loaded.status.userId);

  const status = await db.status.findUnique({
    where: { id },
    select: { id: true, userId: true, type: true, content: true }
  });
  if (!status) throw new ApiError('NOT_FOUND', 'Status not found.', 404);

  const conversationId = await directConversationId(user.id, status.userId);
  const clientNonce = body.clientNonce ? `status-reply:${id}:${body.clientNonce}` : undefined;

  if (clientNonce) {
    const prior = await db.message.findUnique({
      where: { conversationId_clientNonce: { conversationId, clientNonce } },
      include: messageInclude
    });
    if (prior) {
      return ok({
        duplicate: true,
        conversationId,
        message: serializeMessage(prior, user.id)
      });
    }
  }

  const content = statusReplyContent({
    reply: body.text,
    statusType: status.type,
    statusText: status.content
  });

  const message = await db.message.create({
    data: {
      conversationId,
      senderId: user.id,
      type: 'TEXT',
      content,
      clientNonce
    },
    include: messageInclude
  });
  await db.statusReply.create({
    data: { statusId: id, senderId: user.id, messageId: message.id }
  });
  await db.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: message.createdAt }
  });

  emitToConversation(conversationId, EVENTS.MESSAGE_NEW, serializeMessage(message, user.id));
  emitToUser(status.userId, EVENTS.STATUS_REPLIED, {
    statusId: id,
    conversationId,
    messageId: message.id,
    from: user.id
  });

  if (!getActiveViewers(conversationId).includes(status.userId)) {
    await notifyStatusReply({
      authorId: status.userId,
      senderName: user.displayName,
      statusId: id,
      conversationId,
      messageId: message.id,
      replyText: body.text
    });
  }

  return ok({ conversationId, message: serializeMessage(message, user.id) }, { status: 201 });
});
