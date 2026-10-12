import { db } from './db';
import { accessFor } from './billing';
import { entitlementsFor } from './entitlements';
import { shouldSendAway } from './business-rules';
import { emitToConversation } from './realtime';
import { messageInclude, serializeMessage } from './serialize';
import { EVENTS } from '@shared/events';

async function publish(messageId: string, viewerId: string) {
  const full = await db.message.findUnique({ where: { id: messageId }, include: messageInclude });
  if (!full) return;
  emitToConversation(full.conversationId, EVENTS.MESSAGE_NEW, serializeMessage(full, viewerId));
}

/** Greeting from a business when a new direct chat is created. No-op otherwise. */
export async function maybeSendGreeting(conversationId: string, businessUserId: string) {
  const access = await accessFor(businessUserId);
  if (!entitlementsFor(access.plan).includes('business.tools')) return null;
  const profile = await db.businessProfile.findUnique({ where: { userId: businessUserId } });
  const greeting = profile?.greeting?.trim();
  if (!greeting) return null;
  const message = await db.message.create({
    data: { conversationId, senderId: businessUserId, type: 'TEXT', content: greeting }
  });
  await publish(message.id, businessUserId);
  return message;
}

/**
 * Away reply from an entitled business recipient. Does not run for the sender,
 * blocked pairs, or within the cooldown. Never bypasses an earlier permission check.
 */
export async function maybeSendAway(conversationId: string, recipientId: string, senderId: string) {
  if (recipientId === senderId) return null;
  const access = await accessFor(recipientId);
  if (!entitlementsFor(access.plan).includes('business.tools')) return null;
  const profile = await db.businessProfile.findUnique({ where: { userId: recipientId } });
  const blocked = await db.blockedUser.findFirst({
    where: {
      OR: [
        { blockerId: recipientId, blockedId: senderId },
        { blockerId: senderId, blockedId: recipientId }
      ]
    }
  });
  if (
    !shouldSendAway({
      awayEnabled: Boolean(profile?.awayEnabled),
      entitled: true,
      senderIsBusiness: false,
      blocked: Boolean(blocked),
      lastAwayAt: profile?.lastAwayAt ?? null
    })
  ) {
    return null;
  }
  const text = profile?.awayMessage?.trim();
  if (!text) return null;
  const message = await db.message.create({
    data: { conversationId, senderId: recipientId, type: 'TEXT', content: text }
  });
  await db.businessProfile.update({
    where: { userId: recipientId },
    data: { lastAwayAt: new Date() }
  });
  await publish(message.id, recipientId);
  return message;
}
