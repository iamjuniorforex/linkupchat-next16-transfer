import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import { sendMessageSchema } from '@/lib/validation';
import {
  deriveMessageStatus,
  messageInclude,
  requireConversationAccess,
  assertNotBlocked,
  serializeMessage
} from '@/lib/serialize';
import { emitToConversation, emitToUsers, getActiveViewers } from '@/lib/realtime';
import { maybeSendAway } from '@/lib/business-messaging';
import {
  NOTIF_AGGREGATE_WINDOW_MS,
  buildNotificationBody,
  buildNotificationData,
  parseNotificationData,
  shouldAggregate,
  isSafeSegment,
  isMentioned,
  notificationAllowed,
  type NotificationKind
} from '@/lib/notifications';
import { dispatchPush } from '@/lib/push';
import { EVENTS } from '@shared/events';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

/** Paginated message history (newest page first, cursor = ISO date). */
export const GET = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  await requireConversationAccess(user.id, id);

  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? PAGE_SIZE), 100);

  const messages = await db.message.findMany({
    where: {
      conversationId: id,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {})
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: messageInclude
  });

  // Fetching history means these messages reached the viewer's client —
  // advance their delivery cursor (read ⊃ delivered).
  if (messages.length) {
    await db.conversationMember
      .updateMany({
        where: {
          conversationId: id,
          userId: user.id,
          OR: [{ lastDeliveredAt: null }, { lastDeliveredAt: { lt: new Date() } }]
        },
        data: { lastDeliveredAt: new Date() }
      })
      .catch(() => {});
  }

  const memberReads = await db.conversationMember.findMany({
    where: { conversationId: id },
    select: {
      userId: true,
      lastReadAt: true,
      lastDeliveredAt: true,
      leftAt: true,
      user: { select: { settings: { select: { privacyReadReceipts: true, notifPreview: true } } } }
    }
  });
  const memberStatuses = memberReads.map((m) => ({
    userId: m.userId,
    lastReadAt: m.lastReadAt,
    lastDeliveredAt: m.lastDeliveredAt,
    leftAt: m.leftAt,
    privacyReadReceipts: m.user.settings?.privacyReadReceipts ?? true
  }));

  const serialized = await Promise.all(
    messages.map(async (m) => {
      const { status, readBy } = await deriveMessageStatus(m, memberStatuses, user.id);
      return serializeMessage(m, user.id, { status, readBy });
    })
  );

  // serialized is newest-first; flip to chronological for the UI
  serialized.reverse();

  const nextCursor =
    messages.length === limit ? messages[messages.length - 1]!.createdAt.toISOString() : null;

  return ok({ messages: serialized, nextCursor });
});

/** Send a message (text or with pre-uploaded attachment ids). */
export const POST = withAuth(async (req, user, ctx) => {
  enforceUserRateLimit(user.id, 'message:send', 200);
  const { id } = (ctx as { params: { id: string } }).params;
  const access = await requireConversationAccess(user.id, id);
  const body = sendMessageSchema.parse(await readJson(req));

  if (access.conversation.type === 'GROUP' && access.conversation.onlyAdminsMessage && access.role !== 'ADMIN') {
    throw new ApiError('FORBIDDEN', 'Only group admins can send messages in this group.', 403);
  }

  const content = body.content?.trim() ?? '';
  const hasAttachment = (body.attachmentIds?.length ?? 0) > 0;

  if (!content && !hasAttachment && body.type === 'TEXT') {
    throw new ApiError('VALIDATION_ERROR', 'Message cannot be empty.', 422);
  }

  // Enforce block rules for direct conversations
  if (access.conversation.type === 'DIRECT') {
    const other = await db.conversationMember.findFirst({
      where: { conversationId: id, userId: { not: user.id }, leftAt: null }
    });
    if (other) await assertNotBlocked(user.id, other.userId);
  }

  // Validate reply target
  if (body.replyToId) {
    const reply = await db.message.findFirst({
      where: { id: body.replyToId, conversationId: id }
    });
    if (!reply) throw new ApiError('BAD_REQUEST', 'The message you replied to was not found.', 400);
  }

  // Validate + attach pre-uploaded attachments
  const attachments = body.attachmentIds?.length
    ? await db.attachment.findMany({
        where: {
          id: { in: body.attachmentIds },
          uploaderId: user.id,
          messageId: null
        }
      })
    : [];

  if (body.attachmentIds?.length && attachments.length !== body.attachmentIds.length) {
    throw new ApiError('BAD_REQUEST', 'One or more attachments are invalid.', 400);
  }

  // Idempotent sends: a client retry (same clientNonce) returns the message
  // created the first time instead of duplicating it.
  if (body.clientNonce) {
    const replay = await db.message.findFirst({
      where: { conversationId: id, senderId: user.id, clientNonce: body.clientNonce },
      include: messageInclude
    });
    if (replay) {
      const memberReads = await db.conversationMember.findMany({
        where: { conversationId: id },
        select: {
          userId: true,
          lastReadAt: true,
          lastDeliveredAt: true,
          leftAt: true,
          user: { select: { settings: { select: { privacyReadReceipts: true, notifPreview: true } } } }
        }
      });
      const memberStatuses = memberReads.map((m) => ({
        userId: m.userId,
        lastReadAt: m.lastReadAt,
        lastDeliveredAt: m.lastDeliveredAt,
        leftAt: m.leftAt,
        privacyReadReceipts: m.user.settings?.privacyReadReceipts ?? true
      }));
      const { status, readBy } = await deriveMessageStatus(replay, memberStatuses, user.id);
      return ok({ message: serializeMessage(replay, user.id, { status, readBy }), replayed: true }, { status: 200 });
    }
  }

  let message;
  try {
    message = await db.message.create({
      data: {
        conversationId: id,
        senderId: user.id,
        type: body.type,
        content: content || null,
        clientNonce: body.clientNonce ?? null,
        replyToId: body.replyToId ?? null,
        attachments: attachments.length
          ? { connect: attachments.map((a) => ({ id: a.id })) }
          : undefined
      },
      include: messageInclude
    });
  } catch (err) {
    // Concurrent retries raced past the pre-check — the unique constraint on
    // (conversationId, clientNonce) picks one winner; return its message.
    const code = (err as { code?: string })?.code;
    if (code !== 'P2002' || !body.clientNonce) throw err;
    const winner = await db.message.findFirst({
      where: { conversationId: id, clientNonce: body.clientNonce },
      include: messageInclude
    });
    if (!winner) throw err;
    const memberReads = await db.conversationMember.findMany({
      where: { conversationId: id },
      select: {
        userId: true,
        lastReadAt: true,
        lastDeliveredAt: true,
        leftAt: true,
        user: { select: { settings: { select: { privacyReadReceipts: true, notifPreview: true } } } }
      }
    });
    const memberStatuses = memberReads.map((m) => ({
      userId: m.userId,
      lastReadAt: m.lastReadAt,
      lastDeliveredAt: m.lastDeliveredAt,
      leftAt: m.leftAt,
      privacyReadReceipts: m.user.settings?.privacyReadReceipts ?? true
    }));
    const { status, readBy } = await deriveMessageStatus(winner, memberStatuses, user.id);
    return ok({ message: serializeMessage(winner, user.id, { status, readBy }), replayed: true }, { status: 200 });
  }

  await db.conversation.update({
    where: { id },
    data: { lastMessageAt: message.createdAt }
  });

  // Sender has read up to their own message
  await db.conversationMember.updateMany({
    where: { conversationId: id, userId: user.id },
    data: { lastReadAt: message.createdAt, lastReadMessageId: message.id }
  });
  const memberReads = await db.conversationMember.findMany({
    where: { conversationId: id },
    select: {
      userId: true,
      lastReadAt: true,
      lastDeliveredAt: true,
      leftAt: true,
      mutedUntil: true,
      user: {
        select: {
          username: true,
          settings: {
            select: {
              privacyReadReceipts: true,
              notifPreview: true,
              notifEnabled: true,
              notifMessages: true,
              notifGroups: true
            }
          }
        }
      }
    }
  });
  const memberStatuses = memberReads.map((m) => ({
    userId: m.userId,
    lastReadAt: m.lastReadAt,
    lastDeliveredAt: m.lastDeliveredAt,
    leftAt: m.leftAt,
    privacyReadReceipts: m.user.settings?.privacyReadReceipts ?? true
  }));
  const { status, readBy } = await deriveMessageStatus(message, memberStatuses, user.id);
  const payload = serializeMessage(message, user.id, { status, readBy });

  // ── Realtime fan-out ──
  emitToConversation(id, EVENTS.MESSAGE_NEW, payload);

  // In-app notifications for other members
  const recipients = memberReads.filter((m) => m.userId !== user.id && !m.leftAt);
  if (recipients.length) {
    const title =
      access.conversation.type === 'DIRECT'
        ? user.displayName
        : `${user.displayName} in ${access.conversation.title ?? 'a group'}`;

    const kindOf: Record<string, NotificationKind> = {
      TEXT: 'TEXT',
      IMAGE: 'IMAGE',
      VIDEO: 'VIDEO',
      VOICE: 'VOICE',
      AUDIO: 'AUDIO',
      DOCUMENT: 'DOCUMENT',
      GIF: 'GIF',
      STICKER: 'STICKER'
    };
    const kind = kindOf[body.type as string] ?? 'OTHER';

    // Open-chat suppression: recipients ACTIVELY viewing this conversation
    // (visible tab, reported over the ephemeral socket view-state) don't need
    // a notification-center alert. The decision is made here, server-side, so
    // no stale rows are created — Phase 1 message-unread state is untouched.
    const activeViewers = new Set(getActiveViewers(id));

    for (const r of recipients) {
      if (activeViewers.has(r.userId)) continue;

      const mentioned =
        access.conversation.type === 'GROUP' && isMentioned(content, r.user.username);
      if (
        !notificationAllowed({
          channel: access.conversation.type === 'GROUP' ? 'GROUP_MESSAGE' : 'MESSAGE',
          settings: r.user.settings,
          mutedUntil: r.mutedUntil,
          mentioned
        })
      ) {
        continue;
      }

      // notifPreview=false → the STORED body must not contain message text
      // (privacy enforced at creation, not hidden client-side).
      const notifPreview = r.user.settings?.notifPreview ?? true;
      const rowTitle = mentioned ? `${user.displayName} mentioned you` : title;

      // Conservative burst aggregation: roll consecutive messages from this
      // conversation into one feed entry ("N new messages") instead of N
      // identical-looking rows. data keeps {conversationId, messageId, count}
      // — navigation stays intact, schema untouched.
      //
      // The findFirst→update/create section is serialized per
      // (conversation, recipient) with a Postgres advisory transaction lock:
      // concurrent rapid sends previously raced (all missed the lookup → N
      // rows, or double-updated → lost count). No schema/migration needed.
      const row = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`${id}:${r.userId}`})::bigint)::text`;

        const recent = await tx.notification.findFirst({
          where: {
            userId: r.userId,
            type: 'MESSAGE',
            readAt: null,
            data: { contains: id },
            createdAt: { gte: new Date(Date.now() - NOTIF_AGGREGATE_WINDOW_MS) }
          },
          orderBy: { createdAt: 'desc' }
        });

        if (shouldAggregate(recent, { conversationId: id })) {
          const count = (parseNotificationData(recent!.data)?.count ?? 1) + 1;
          const priorMention = parseNotificationData(recent!.data)?.mention === true;
          return tx.notification.update({
            where: { id: recent!.id },
            data: {
              title: mentioned ? rowTitle : undefined,
              body: buildNotificationBody({ kind, text: content, notifPreview, count }),
              data: buildNotificationData(id, message.id, count, { mention: mentioned || priorMention }),
              createdAt: new Date() // bump to top of the feed
            }
          });
        }
        return tx.notification.create({
          data: {
            userId: r.userId,
            type: 'MESSAGE',
            title: rowTitle,
            body: buildNotificationBody({ kind, text: content, notifPreview, count: 1 }),
            data: buildNotificationData(id, message.id, 1, { mention: mentioned })
          }
        });
      });

      emitToUsers([r.userId], EVENTS.NOTIFICATION_NEW, {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        data: parseNotificationData(row.data),
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
      });

      // Web Push (Phase 3): same notification row delivered out-of-app. The
      // body is the privacy-filtered row body (notifPreview enforced at
      // creation); the tag coalesces per conversation so one device never
      // stacks duplicates. Fire-and-forget — a slow push provider must never
      // slow message sending; failures are logged as counts only.
      void dispatchPush({
        userId: r.userId,
        kind: access.conversation.type === 'GROUP' ? 'GROUP_MESSAGE' : 'MESSAGE',
        title: row.title,
        body: row.body ?? undefined,
        notificationId: row.id,
        data: { url: isSafeSegment(message.id) ? `/app/chats/${id}?message=${message.id}` : `/app/chats/${id}` },
        tag: id
      }).catch(() => {});
    }
  }

  if (access.conversation.type === 'DIRECT') {
    const other = recipients.find((r) => r.userId !== user.id);
    if (other) {
      try {
        await maybeSendAway(id, other.userId, user.id);
      } catch {
        // Away replies must not fail the sender's message.
      }
    }
  }

  return ok({ message: payload }, { status: 201 });
});
