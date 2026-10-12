import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import { reactionSchema } from '@/lib/validation';
import { requireConversationAccess, assertNotBlocked } from '@/lib/serialize';
import { emitToConversation, emitToUsers, getActiveViewers } from '@/lib/realtime';
import {
  buildReactionNotification,
  buildReactionNotificationData,
  parseNotificationData
} from '@/lib/notifications';
import { dispatchPush } from '@/lib/push';
import { EVENTS } from '@shared/events';

export const dynamic = 'force-dynamic';

/**
 * Set / change / remove the caller's reaction on a message.
 *
 * One reaction per user per message: selecting a NEW emoji REPLACES the
 * user's previous reaction; selecting their CURRENT emoji removes it.
 * The critical section is transactional (delete-then-create), and the
 * @@unique([messageId, userId, emoji]) constraint + P2002 handling guarantee
 * duplicate client events/retries can never create duplicate reaction rows.
 */
export const POST = withAuth(async (req, user, ctx) => {
  enforceUserRateLimit(user.id, 'reaction', 60);
  const { id } = (ctx as { params: { id: string } }).params;
  const body = reactionSchema.parse(await readJson(req));

  const message = await db.message.findUnique({ where: { id } });
  if (!message || message.deletedAt) throw new ApiError('NOT_FOUND', 'Message not found.', 404);
  const access = await requireConversationAccess(user.id, message.conversationId);

  // Respect existing block rules for 1:1 conversations (same as sending).
  if (access.conversation.type === 'DIRECT') {
    const other = await db.conversationMember.findFirst({
      where: { conversationId: message.conversationId, userId: { not: user.id } }
    });
    if (other) await assertNotBlocked(user.id, other.userId);
  }

  // Replace-or-remove inside one transaction. The whole critical section —
  // including the authoritative full-row snapshot used for the realtime
  // emit — is serialized per MESSAGE with a Postgres advisory transaction
  // lock: concurrent rapid toggles can never interleave into duplicate rows
  // (a user has at most one reaction), and emissions for a message are
  // totally ordered so every client converges to the same state.
  const { reacted, reactions } = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'reaction:' + id})::bigint)::text`;

    const mine = await tx.messageReaction.findMany({
      where: { messageId: id, userId: user.id },
      select: { emoji: true }
    });
    const hadSame = mine.some((r) => r.emoji === body.emoji);

    // Clear the user's previous reaction(s) — at most one per message.
    await tx.messageReaction.deleteMany({ where: { messageId: id, userId: user.id } });

    let reacted = false;
    if (!hadSame) {
      try {
        await tx.messageReaction.create({
          data: { messageId: id, userId: user.id, emoji: body.emoji }
        });
        reacted = true;
      } catch (err) {
        // P2002: a duplicated client event landed first — treat as applied,
        // never surface a 500 or a duplicate row.
        if ((err as { code?: string }).code !== 'P2002') throw err;
        reacted = true;
      }
    }

    const rows = await tx.messageReaction.findMany({
      where: { messageId: id },
      select: { emoji: true, userId: true }
    });
    return { reacted, reactions: rows };
  });

  // Full reaction rows (snapshotted under the lock) → clients rebuild the
  // aggregate deterministically — sufficient to update the message without
  // refetching the conversation.
  emitToConversation(message.conversationId, EVENTS.MESSAGE_REACTION, {
    messageId: id,
    conversationId: message.conversationId,
    reactions,
    userId: user.id,
    emoji: body.emoji,
    reacted
  });

  // ── Reaction notification for the MESSAGE AUTHOR (away-only) ──
  // Author-only: reacting to someone's message notifies that someone.
  // Open-chat suppression reuses the Phase 2 view-state (no row while the
  // author is actively viewing). Type REACTION already exists in the schema
  // enum — it never aggregates with MESSAGE rows. notifPreview=false keeps
  // the reacted message's text out of the stored body.
  const authorId = message.senderId;
  if (authorId && authorId !== user.id) {
    const matchExisting = {
      userId: authorId,
      type: 'REACTION' as const,
      AND: [{ data: { contains: id } }, { data: { contains: user.id } }]
    };

    if (!reacted) {
      // Reaction removed → the notification is no longer true: delete it.
      // (Connected clients also prune locally via the MESSAGE_REACTION event.)
      await db.notification.deleteMany({ where: matchExisting });
    } else {
      const authorMember = await db.conversationMember.findFirst({
        where: { conversationId: message.conversationId, userId: authorId, leftAt: null },
        select: {
          user: { select: { settings: { select: { notifPreview: true } } } }
        }
      });
      const authorViewing = getActiveViewers(message.conversationId).includes(authorId);

      // One reaction notification per (author, message, reactor): an emoji
      // change updates the same row in place (same id → clients replace).
      const existing = await db.notification.findFirst({
        where: matchExisting,
        orderBy: { createdAt: 'desc' }
      });

      // While the author is actively viewing: never CREATE a row (open-chat
      // suppression). An existing row still gets its emoji corrected in place
      // (no createdAt bump → no re-surfacing).
      if (authorMember && (existing || !authorViewing)) {
        const notifPreview = authorMember.user.settings?.notifPreview ?? true;
        const kindMap: Record<string, 'TEXT' | 'IMAGE' | 'VIDEO' | 'VOICE' | 'AUDIO' | 'DOCUMENT' | 'GIF' | 'STICKER' | 'OTHER'> = {
          TEXT: 'TEXT', IMAGE: 'IMAGE', VIDEO: 'VIDEO', VOICE: 'VOICE', AUDIO: 'AUDIO',
          DOCUMENT: 'DOCUMENT', GIF: 'GIF', STICKER: 'STICKER'
        };
        const { title, body: bodyText } = buildReactionNotification({
          reactorName: user.displayName,
          emoji: body.emoji,
          groupTitle: access.conversation.type === 'GROUP' ? access.conversation.title : null,
          notifPreview,
          messageText: message.content,
          messageKind: kindMap[message.type] ?? 'OTHER'
        });
        const data = buildReactionNotificationData(message.conversationId, id, user.id, body.emoji);

        const row = existing
          ? await db.notification.update({
              where: { id: existing.id },
              data: {
                title,
                body: bodyText,
                data,
                // Bump to the top only when the author is away (real new
                // activity for them); silent correction while viewing.
                ...(authorViewing ? {} : { createdAt: new Date() })
              }
            })
          : await db.notification.create({
              data: {
                userId: authorId,
                type: 'REACTION',
                title,
                body: bodyText,
                data
              }
            });

        emitToUsers([authorId], EVENTS.NOTIFICATION_NEW, {
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          data: parseNotificationData(row.data),
          readAt: row.readAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString()
        });

        // Web Push: only for real new activity (the author is away) — a
        // silent emoji correction while they are viewing never pushes.
        if (!authorViewing) {
          void dispatchPush({
            userId: authorId,
            kind: access.conversation.type === 'GROUP' ? 'GROUP_MESSAGE' : 'REACTION',
            title: row.title,
            body: row.body ?? undefined,
            data: { url: `/app/chats/${message.conversationId}?message=${id}` },
            tag: message.conversationId
          }).catch(() => {});
        }
      }
    }
  }

  return ok({ reacted, reactions });
});
