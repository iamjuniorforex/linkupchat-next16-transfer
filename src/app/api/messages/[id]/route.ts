import { db } from '@/lib/db';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import { editMessageSchema } from '@/lib/validation';
import { messageInclude, requireConversationAccess, serializeMessage } from '@/lib/serialize';
import { tryDeleteExclusiveAttachment } from '@/lib/attachment-cleanup';
import { emitToConversation } from '@/lib/realtime';
import { EVENTS } from '@shared/events';

export const dynamic = 'force-dynamic';

/** Edit my own message (text messages only). */
export const PATCH = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  const body = editMessageSchema.parse(await readJson(req));

  const message = await db.message.findUnique({ where: { id }, include: messageInclude });
  if (!message || message.deletedAt) throw new ApiError('NOT_FOUND', 'Message not found.', 404);
  await requireConversationAccess(user.id, message.conversationId);

  if (message.senderId !== user.id) {
    throw new ApiError('FORBIDDEN', 'You can only edit your own messages.', 403);
  }
  if (message.type !== 'TEXT') {
    throw new ApiError('BAD_REQUEST', 'Only text messages can be edited.', 400);
  }

  const updated = await db.message.update({
    where: { id },
    data: { content: body.content, editedAt: new Date() },
    include: messageInclude
  });

  const payload = serializeMessage(updated, user.id, { status: 'SENT' });
  emitToConversation(message.conversationId, EVENTS.MESSAGE_UPDATED, payload);

  return ok({ message: payload });
});

/** Soft-delete a message. */
export const DELETE = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;

  const message = await db.message.findUnique({
    where: { id },
    include: { attachments: { select: { id: true } } }
  });
  if (!message) throw new ApiError('NOT_FOUND', 'Message not found.', 404);

  const access = await requireConversationAccess(user.id, message.conversationId);
  const isMine = message.senderId === user.id;
  const canModerate = access.role === 'ADMIN';

  if (!isMine && !canModerate) {
    throw new ApiError('FORBIDDEN', 'You can only delete your own messages.', 403);
  }

  const priorAttachmentIds = message.attachments.map((a) => a.id);

  await db.message.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      deletedById: user.id,
      content: null,
      // Keep structural relations but clear media references from the thread
      attachments: { set: [] }
    }
  });

  // Attachment lifecycle (audit remediation) — mirrors Status deletion: an
  // attachment that exclusively backed this message is removed (storage
  // object + row); anything still shared with a live Status, another message
  // or avatar usage is left untouched. Cleanup is best-effort and can never
  // fail the deletion above.
  for (const attachmentId of priorAttachmentIds) {
    await tryDeleteExclusiveAttachment(attachmentId);
  }

  emitToConversation(message.conversationId, EVENTS.MESSAGE_DELETED, {
    messageId: id,
    conversationId: message.conversationId,
    deletedBy: user.id,
    forEveryone: true
  });

  return ok({ deleted: true });
});
