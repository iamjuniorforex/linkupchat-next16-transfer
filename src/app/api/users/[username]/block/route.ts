import { db } from '@/lib/db';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/** Block or unblock a user (Section 24). */
export const POST = withAuth(async (req, user, ctx) => {
  const { username } = (ctx as { params: { username: string } }).params;
  const body = z.object({ blocked: z.boolean() }).parse(await readJson(req));

  const target = await db.user.findUnique({ where: { username: username.toLowerCase() } });
  if (!target) throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
  if (target.id === user.id) throw new ApiError('VALIDATION_ERROR', 'You cannot block yourself.', 422);

  if (body.blocked) {
    await db.blockedUser.upsert({
      where: { blockerId_blockedId: { blockerId: user.id, blockedId: target.id } },
      update: {},
      create: { blockerId: user.id, blockedId: target.id }
    });
    await db.contact.deleteMany({
      where: {
        OR: [
          { ownerId: user.id, contactId: target.id },
          { ownerId: target.id, contactId: user.id }
        ]
      }
    });
  } else {
    await db.blockedUser.deleteMany({
      where: { blockerId: user.id, blockedId: target.id }
    });
  }

  return ok({ blocked: body.blocked });
});
