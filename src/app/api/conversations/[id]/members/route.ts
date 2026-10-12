import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import { requireConversationAccess } from '@/lib/serialize';
import { emitToConversation, emitToUsers, joinUserToConversation, removeUserFromConversation } from '@/lib/realtime';
import { EVENTS } from '@shared/events';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const addSchema = z.object({ userIds: z.array(z.string().min(1)).min(1).max(50) });
const removeSchema = z.object({ userId: z.string().min(1) });
const roleSchema = z.object({ userId: z.string().min(1), role: z.enum(['MEMBER', 'ADMIN']) });

const GROUP_MEMBER_CAP = 256;

/**
 * Serializes membership mutations per conversation. Every membership change
 * (add / remove / role) takes the same advisory lock for the conversation, so
 * concurrent requests — e.g. two last admins leaving at once — are ordered and
 * the last-admin invariant can never be raced past.
 */
async function withGroupLock<T>(
  conversationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      // ::text cast — pg_advisory_xact_lock returns void, which Prisma
      // cannot deserialize as a result column.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conversationId}, 0))::text`;
      return fn(tx);
    },
    { timeout: 15_000 }
  );
}

/** Throws when the change would leave the group without any admin. */
async function assertNotLastAdmin(
  tx: Prisma.TransactionClient,
  conversationId: string,
  targetUserId: string,
  targetRole: 'MEMBER' | 'ADMIN',
  action: 'leave' | 'remove' | 'demote'
) {
  if (targetRole !== 'ADMIN') return;
  const admins = await tx.conversationMember.count({
    where: { conversationId, leftAt: null, role: 'ADMIN' }
  });
  if (admins <= 1) {
    const message =
      action === 'demote'
        ? 'Promote another admin before demoting the last admin.'
        : action === 'leave'
          ? 'Promote another admin before leaving the group.'
          : 'Promote another admin before removing the last admin.';
    throw new ApiError('LAST_ADMIN', message, 403);
  }
}

/** Add members to a group (Section 10). */
export const POST = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  const access = await requireConversationAccess(user.id, id);

  if (access.conversation.type !== 'GROUP') {
    throw new ApiError('BAD_REQUEST', 'Members can only be added to groups.', 400);
  }
  if (access.conversation.onlyAdminsAddMembers && access.role !== 'ADMIN') {
    throw new ApiError('FORBIDDEN', 'Only group admins can add members.', 403);
  }

  const body = addSchema.parse(await readJson(req));
  const userIds = Array.from(new Set(body.userIds));

  // Members must be real, non-banned users.
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, status: true }
  });
  if (users.length !== userIds.length) {
    throw new ApiError('USER_NOT_FOUND', 'One or more users could not be found.', 404);
  }
  if (users.some((u) => u.status === 'BANNED')) {
    throw new ApiError('USER_BANNED', 'Banned users cannot be added to groups.', 422);
  }

  await withGroupLock(id, async (tx) => {
    const active = await tx.conversationMember.count({
      where: { conversationId: id, leftAt: null }
    });
    const alreadyActive = await tx.conversationMember.count({
      where: { conversationId: id, userId: { in: userIds }, leftAt: null }
    });
    const adding = userIds.length - alreadyActive;
    if (active + adding > GROUP_MEMBER_CAP) {
      throw new ApiError('GROUP_FULL', `Groups are limited to ${GROUP_MEMBER_CAP} members.`, 422);
    }

    for (const userId of userIds) {
      await tx.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: id, userId } },
        update: { leftAt: null },
        create: { conversationId: id, userId }
      });
    }
  });

  await db.message.create({
    data: {
      conversationId: id,
      senderId: user.id,
      type: 'SYSTEM',
      content: `${user.displayName} added ${users.map((u) => u.displayName).join(', ')}`
    }
  });

  // Instant realtime access for the new members' live sockets.
  for (const uid of userIds) joinUserToConversation(uid, id);

  emitToUsers(userIds, EVENTS.CONVERSATION_UPDATED, { conversationId: id, added: true });
  emitToConversation(id, EVENTS.CONVERSATION_UPDATED, { conversationId: id, membersChanged: true });

  return ok({ added: userIds });
});

/** Remove a member (or leave the group). */
export const DELETE = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  const access = await requireConversationAccess(user.id, id);

  if (access.conversation.type !== 'GROUP') {
    throw new ApiError('BAD_REQUEST', 'Members can only be removed from groups.', 400);
  }

  const body = removeSchema.parse(await readJson(req));
  const isSelf = body.userId === user.id;

  if (!isSelf && access.role !== 'ADMIN') {
    throw new ApiError('FORBIDDEN', 'Only group admins can remove members.', 403);
  }

  await withGroupLock(id, async (tx) => {
    const target = await tx.conversationMember.findFirst({
      where: { conversationId: id, userId: body.userId, leftAt: null }
    });
    if (!target) {
      throw new ApiError('NOT_FOUND', 'This person is not a member of the group.', 404);
    }
    // Last-admin safety (D1): the last admin cannot leave or be removed.
    await assertNotLastAdmin(tx, id, body.userId, target.role as 'MEMBER' | 'ADMIN', isSelf ? 'leave' : 'remove');

    await tx.conversationMember.updateMany({
      where: { conversationId: id, userId: body.userId, leftAt: null },
      data: { leftAt: new Date() }
    });
  });

  const target = await db.user.findUnique({ where: { id: body.userId }, select: { displayName: true } });
  await db.message.create({
    data: {
      conversationId: id,
      senderId: user.id,
      type: 'SYSTEM',
      content: isSelf
        ? `${user.displayName} left the group`
        : `${user.displayName} removed ${target?.displayName ?? 'a member'}`
    }
  });

  // Instant realtime eviction — the removed member stops receiving events now.
  removeUserFromConversation(body.userId, id);

  emitToConversation(id, EVENTS.CONVERSATION_UPDATED, {
    conversationId: id,
    membersChanged: true
  });
  emitToUsers([body.userId], EVENTS.CONVERSATION_UPDATED, { conversationId: id, removed: true });

  return ok({ removed: body.userId });
});

/** Promote/demote a member between MEMBER and ADMIN. */
export const PATCH = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  const access = await requireConversationAccess(user.id, id);

  if (access.conversation.type !== 'GROUP') throw new ApiError('BAD_REQUEST', 'Not a group.', 400);
  if (access.role !== 'ADMIN') throw new ApiError('FORBIDDEN', 'Only group admins can change roles.', 403);

  const body = roleSchema.parse(await readJson(req));

  const changed = await withGroupLock(id, async (tx) => {
    const target = await tx.conversationMember.findFirst({
      where: { conversationId: id, userId: body.userId, leftAt: null }
    });
    if (!target) {
      throw new ApiError('NOT_FOUND', 'This person is not a member of the group.', 404);
    }
    const currentRole = target.role as 'MEMBER' | 'ADMIN';
    if (currentRole === body.role) return null; // already in the requested role

    // Last-admin safety (D1): the last admin cannot be demoted (including self).
    await assertNotLastAdmin(tx, id, body.userId, currentRole, 'demote');

    await tx.conversationMember.updateMany({
      where: { conversationId: id, userId: body.userId, leftAt: null },
      data: { role: body.role }
    });
    return target;
  });

  if (changed) {
    const targetUser = await db.user.findUnique({
      where: { id: body.userId },
      select: { displayName: true }
    });
    await db.message.create({
      data: {
        conversationId: id,
        senderId: user.id,
        type: 'SYSTEM',
        content:
          body.role === 'ADMIN'
            ? `${targetUser?.displayName ?? 'A member'} is now an admin`
            : `${targetUser?.displayName ?? 'A member'} is no longer an admin`
      }
    });

    emitToConversation(id, EVENTS.CONVERSATION_UPDATED, { conversationId: id, membersChanged: true });
  }

  return ok({ userId: body.userId, role: body.role, changed: Boolean(changed) });
});
