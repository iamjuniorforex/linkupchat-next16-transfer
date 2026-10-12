import { db } from '@/lib/db';
import { withAuth, requireAdmin, ok, readJson, ApiError } from '@/lib/api';
import { disconnectUserSockets } from '@/lib/realtime';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/** Search / list users for moderation. */
export const GET = withAuth(async (req, user) => {
  requireAdmin(user);

  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const take = 20;

  const users = await db.user.findMany({
    where: q
      ? {
          OR: [
            { username: { contains: q.toLowerCase(), mode: 'insensitive' } },
            { displayName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q.toLowerCase(), mode: 'insensitive' } }
          ]
        }
      : undefined,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * take,
    take,
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
      lastSeenAt: true,
      _count: { select: { messages: true } }
    }
  });

  return ok({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
      messageCount: u._count.messages
    })),
    page
  });
});

const patchSchema = z.object({
  userId: z.string(),
  action: z.enum(['SUSPEND', 'BAN', 'ACTIVATE', 'SET_ROLE']),
  role: z.enum(['USER', 'MODERATOR', 'ADMIN']).optional()
});

/** Suspend / ban / activate accounts, assign roles. */
export const PATCH = withAuth(async (req, user) => {
  requireAdmin(user);
  const body = patchSchema.parse(await readJson(req));

  const target = await db.user.findUnique({ where: { id: body.userId } });
  if (!target) throw new ApiError('NOT_FOUND', 'User not found.', 404);
  if (target.id === user.id) throw new ApiError('VALIDATION_ERROR', 'You cannot moderate your own account.', 422);
  if (user.role !== 'ADMIN' && target.role === 'ADMIN') {
    throw new ApiError('FORBIDDEN', 'Only admins can moderate other admins.', 403);
  }

  switch (body.action) {
    case 'SUSPEND':
      await db.user.update({ where: { id: body.userId }, data: { status: 'SUSPENDED' } });
      await db.session.updateMany({
        where: { userId: body.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      // Suspended accounts lose realtime access immediately.
      disconnectUserSockets(body.userId);
      break;
    case 'BAN':
      await db.user.update({ where: { id: body.userId }, data: { status: 'BANNED' } });
      await db.session.updateMany({
        where: { userId: body.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      // Banned accounts lose realtime access immediately.
      disconnectUserSockets(body.userId);
      break;
    case 'ACTIVATE':
      await db.user.update({ where: { id: body.userId }, data: { status: 'ACTIVE' } });
      break;
    case 'SET_ROLE':
      if (user.role !== 'ADMIN') throw new ApiError('FORBIDDEN', 'Only admins can change roles.', 403);
      await db.user.update({ where: { id: body.userId }, data: { role: body.role ?? 'USER' } });
      break;
  }

  return ok({ userId: body.userId, action: body.action });
});
