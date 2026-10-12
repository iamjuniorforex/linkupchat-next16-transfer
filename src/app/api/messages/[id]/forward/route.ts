import { db } from '@/lib/db';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import {
  messageInclude,
  requireConversationAccess,
  serializeMessage
} from '@/lib/serialize';
import { emitToConversation } from '@/lib/realtime';
import { EVENTS } from '@shared/events';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const schema = z.object({
  conversationIds: z.array(z.string()).min(1).max(10)
});

/** Forward a message (or media) to other conversations. */
export const POST = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  const body = schema.parse(await readJson(req));

  const source = await db.message.findUnique({ where: { id }, include: messageInclude });
  if (!source || source.deletedAt) throw new ApiError('NOT_FOUND', 'Message not found.', 404);
  await requireConversationAccess(user.id, source.conversationId);

  const created = [];

  for (const conversationId of body.conversationIds) {
    await requireConversationAccess(user.id, conversationId);

    const forwarded = await db.message.create({
      data: {
        conversationId,
        senderId: user.id,
        type: source.type,
        content: source.content,
        forwardedFromId: source.id,
        attachments: source.attachments?.length
          ? {
              create: source.attachments.map((a) => ({
                kind: a.kind,
                storageKey: a.storageKey,
                url: a.url,
                thumbnailUrl: a.thumbnailUrl,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes,
                width: a.width,
                height: a.height,
                durationMs: a.durationMs,
                fileName: a.fileName,
                uploaderId: user.id
              }))
            }
          : undefined
      },
      include: messageInclude
    });

    await db.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: forwarded.createdAt }
    });

    const payload = serializeMessage(forwarded, user.id, { status: 'SENT' });
    emitToConversation(conversationId, EVENTS.MESSAGE_NEW, payload);
    created.push(payload);
  }

  return ok({ messages: created }, { status: 201 });
});
