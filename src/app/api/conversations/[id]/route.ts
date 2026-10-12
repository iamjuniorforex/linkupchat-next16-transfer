import { db } from '@/lib/db';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import {
  messageInclude,
  requireConversationAccess,
  serializeConversation,
  serializeMessage
} from '@/lib/serialize';
import { emitToConversation } from '@/lib/realtime';
import { EVENTS } from '@shared/events';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  await requireConversationAccess(user.id, id);

  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id },
    include: {
      members: {
        where: { leftAt: null },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              isOnline: true,
              lastSeenAt: true,
              about: true
            }
          }
        }
      }
    }
  });

  const myMember = conversation.members.find((m) => m.userId === user.id)!;

  const last = await db.message.findFirst({
    where: { conversationId: id, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: messageInclude
  });

  // Same baseline as the list endpoint: max(lastReadAt, joinedAt) so late
  // group joins do not inherit pre-join history.
  const baseline =
    myMember.lastReadAt && myMember.lastReadAt > myMember.joinedAt
      ? myMember.lastReadAt
      : myMember.joinedAt;

  const unreadCount = await db.message.count({
    where: {
      conversationId: id,
      senderId: { not: user.id },
      deletedAt: null,
      createdAt: { gt: baseline }
    }
  });

  return ok({
    conversation: await serializeConversation(conversation, user.id, {
      members: conversation.members,
      myMember,
      lastMessage: last ? serializeMessage(last, user.id) : null,
      unreadCount
    })
  });
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  avatarUrl: z.string().max(1024).nullable().optional(),
  onlyAdminsMessage: z.boolean().optional(),
  onlyAdminsEditInfo: z.boolean().optional(),
  onlyAdminsAddMembers: z.boolean().optional()
});

/** Update group info / permissions (admin-gated where appropriate). */
export const PATCH = withAuth(async (req, user, ctx) => {
  const { id } = (ctx as { params: { id: string } }).params;
  const access = await requireConversationAccess(user.id, id);

  if (access.conversation.type !== 'GROUP') {
    throw new ApiError('BAD_REQUEST', 'Only group conversations can be updated.', 400);
  }

  const body = patchSchema.parse(await readJson(req));
  const editsInfo = body.title !== undefined || body.description !== undefined || body.avatarUrl !== undefined;
  const touchesPermissions =
    body.onlyAdminsMessage !== undefined ||
    body.onlyAdminsAddMembers !== undefined ||
    body.onlyAdminsEditInfo !== undefined;

  // Permission flags are always admin-only — regular members can never
  // change who is allowed to message / edit info / add members.
  if (touchesPermissions && access.role !== 'ADMIN') {
    throw new ApiError('FORBIDDEN', 'Only group admins can change group permissions.', 403);
  }
  // Group info edits honour the onlyAdminsEditInfo flag (any member when off).
  if (editsInfo && access.conversation.onlyAdminsEditInfo && access.role !== 'ADMIN') {
    throw new ApiError('FORBIDDEN', 'Only group admins can edit group information.', 403);
  }

  const updated = await db.conversation.update({
    where: { id },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
      ...(body.onlyAdminsMessage !== undefined ? { onlyAdminsMessage: body.onlyAdminsMessage } : {}),
      ...(body.onlyAdminsEditInfo !== undefined ? { onlyAdminsEditInfo: body.onlyAdminsEditInfo } : {}),
      ...(body.onlyAdminsAddMembers !== undefined ? { onlyAdminsAddMembers: body.onlyAdminsAddMembers } : {})
    }
  });

  emitToConversation(id, EVENTS.CONVERSATION_UPDATED, {
    conversationId: id,
    title: updated.title,
    description: updated.description,
    avatarUrl: updated.avatarUrl
  });

  return ok({ conversationId: id, updated: true });
});
