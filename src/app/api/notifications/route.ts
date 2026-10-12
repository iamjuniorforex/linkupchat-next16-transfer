import { db } from '@/lib/db';
import { withAuth, ok, readJson } from '@/lib/api';
import { emitToUser } from '@/lib/realtime';
import { EVENTS } from '@shared/events';
import { z } from 'zod';
import type { NotificationDTO } from '@/types';

export const dynamic = 'force-dynamic';

/** My notification feed. */
export const GET = withAuth(async (req, user) => {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get('unread') === 'true';

  const notifications = await db.notification.findMany({
    where: {
      userId: user.id,
      ...(unreadOnly ? { readAt: null } : {})
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  const unreadCount = await db.notification.count({
    where: { userId: user.id, readAt: null }
  });

  const dto: NotificationDTO[] = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    data: n.data ? (JSON.parse(n.data) as Record<string, unknown>) : null,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString()
  }));

  return ok({ notifications: dto, unreadCount });
});

const patchSchema = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
  /** Mark every notification tied to a conversation read (chat opened). */
  conversationId: z.string().optional()
});

/** Mark notifications as read (by ids, by conversation, or all). */
export const PATCH = withAuth(async (req, user) => {
  const body = patchSchema.parse(await readJson(req));
  const where = {
    userId: user.id,
    readAt: null as Date | null,
    ...(body.all
      ? {}
      : body.conversationId
        ? { data: { contains: body.conversationId } }
        : { id: { in: body.ids ?? [] } })
  };
  const pending = await db.notification.findMany({ where, select: { id: true } });
  const readAt = new Date();
  const result = await db.notification.updateMany({ where, data: { readAt } });
  const unread = await db.notification.count({ where: { userId: user.id, readAt: null } });

  if (pending.length > 0) {
    emitToUser(user.id, EVENTS.NOTIFICATION_READ, {
      ids: body.all ? 'all' : pending.map((row) => row.id),
      readAt: readAt.toISOString()
    });
  }

  return ok({ updated: result.count, unread });
});

const deleteSchema = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional()
});

/** Delete notifications (by ids or all) — clears the feed without marking read. */
export const DELETE = withAuth(async (req, user) => {
  const body = deleteSchema.parse(await readJson(req));

  const result = await db.notification.deleteMany({
    where: {
      userId: user.id,
      ...(body.all ? {} : { id: { in: body.ids ?? [] } })
    }
  });

  return ok({ deleted: result.count });
});
