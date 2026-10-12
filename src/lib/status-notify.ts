/**
 * Phase 15 status notifications. Reuses the existing notification rows,
 * realtime event, and push dispatcher. Previews follow notifPreview.
 * Repeated updates from the same author collapse into one unread row.
 */
import { db } from '@/lib/db';
import { emitToUsers } from '@/lib/realtime';
import { dispatchPush } from '@/lib/push';
import { notificationAllowed, parseNotificationData } from '@/lib/notifications';
import { buildStatusReactionNotice, buildStatusReplyNotice, buildStatusUpdateNotice } from '@/lib/status-stories';
import { EVENTS } from '@shared/events';

const UPDATE_WINDOW_MS = 6 * 60 * 60 * 1000;

function emitRow(userId: string, row: { id: string; type: string; title: string; body: string | null; data: string | null; readAt: Date | null; createdAt: Date }) {
  emitToUsers([userId], EVENTS.NOTIFICATION_NEW, {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: parseNotificationData(row.data),
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  });
}

export async function notifyStatusUpdates(recipientIds: string[], authorId: string, authorName: string, statusId: string) {
  if (!recipientIds.length) return;
  const settings = await db.userSettings.findMany({
    where: { userId: { in: recipientIds } },
    select: { userId: true, notifEnabled: true, notifStatus: true }
  });
  const allowed = new Set(
    settings.filter((s) => notificationAllowed({ channel: 'STATUS', settings: s })).map((s) => s.userId)
  );
  // Missing settings default to enabled.
  for (const id of recipientIds) {
    if (!settings.some((s) => s.userId === id)) allowed.add(id);
  }

  for (const userId of recipientIds) {
    if (!allowed.has(userId)) continue;
    const marker = `"kind":"status-update","userId":"${authorId}"`;
    const existing = await db.notification.findFirst({
      where: {
        userId,
        type: 'SYSTEM',
        readAt: null,
        data: { contains: marker },
        createdAt: { gte: new Date(Date.now() - UPDATE_WINDOW_MS) }
      },
      orderBy: { createdAt: 'desc' }
    });
    const prevCount = existing ? Number(parseNotificationData(existing.data)?.count ?? 1) : 0;
    const count = prevCount + 1;
    const { title, body } = buildStatusUpdateNotice({ authorName, count });
    const data = JSON.stringify({ kind: 'status-update', userId: authorId, statusId, count });
    const row = existing
      ? await db.notification.update({
          where: { id: existing.id },
          data: { title, body, data, createdAt: new Date() }
        })
      : await db.notification.create({
          data: { userId, type: 'SYSTEM', title, body, data }
        });
    emitRow(userId, row);
    if (!existing) {
      void dispatchPush({
        userId,
        kind: 'STATUS',
        title,
        body,
        notificationId: row.id,
        data: { url: '/app/status' },
        tag: `status-${authorId}`
      }).catch(() => {});
    }
  }
}

export async function notifyStatusReaction(args: {
  authorId: string;
  reactorId: string;
  reactorName: string;
  statusId: string;
  emoji: string;
  statusText?: string | null;
}) {
  if (args.authorId === args.reactorId) return;
  const settings = await db.userSettings.findUnique({
    where: { userId: args.authorId },
    select: { notifEnabled: true, notifStatus: true, notifPreview: true }
  });
  if (settings && !notificationAllowed({ channel: 'STATUS', settings })) return;
  const { title, body } = buildStatusReactionNotice({
    reactorName: args.reactorName,
    emoji: args.emoji,
    notifPreview: settings?.notifPreview ?? true,
    statusText: args.statusText
  });
  const marker = `"kind":"status-reaction","statusId":"${args.statusId}","reactorId":"${args.reactorId}"`;
  const data = JSON.stringify({
    kind: 'status-reaction',
    statusId: args.statusId,
    reactorId: args.reactorId,
    emoji: args.emoji
  });
  const existing = await db.notification.findFirst({
    where: { userId: args.authorId, type: 'REACTION', readAt: null, data: { contains: marker } },
    orderBy: { createdAt: 'desc' }
  });
  const row = existing
    ? await db.notification.update({
        where: { id: existing.id },
        data: { title, body, data, createdAt: new Date() }
      })
    : await db.notification.create({
        data: { userId: args.authorId, type: 'REACTION', title, body, data }
      });
  emitRow(args.authorId, row);
  void dispatchPush({
    userId: args.authorId,
    kind: 'STATUS',
    title,
    body,
    notificationId: row.id,
    data: { url: '/app/status' },
    tag: `status-react-${args.statusId}`
  }).catch(() => {});
}

export async function notifyStatusReply(args: {
  authorId: string;
  senderName: string;
  statusId: string;
  conversationId: string;
  messageId: string;
  replyText: string;
}) {
  const settings = await db.userSettings.findUnique({
    where: { userId: args.authorId },
    select: { notifEnabled: true, notifStatus: true, notifPreview: true }
  });
  if (settings && !notificationAllowed({ channel: 'STATUS', settings })) return;
  const { title, body } = buildStatusReplyNotice({
    senderName: args.senderName,
    notifPreview: settings?.notifPreview ?? true,
    replyText: args.replyText
  });
  const data = JSON.stringify({
    kind: 'status-reply',
    statusId: args.statusId,
    conversationId: args.conversationId,
    messageId: args.messageId
  });
  const row = await db.notification.create({
    data: { userId: args.authorId, type: 'REPLY', title, body, data }
  });
  emitRow(args.authorId, row);
  void dispatchPush({
    userId: args.authorId,
    kind: 'STATUS',
    title,
    body,
    notificationId: row.id,
    data: { url: `/app/chats/${args.conversationId}?message=${args.messageId}` },
    tag: args.conversationId
  }).catch(() => {});
}
