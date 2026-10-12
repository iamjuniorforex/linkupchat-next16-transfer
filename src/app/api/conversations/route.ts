import { db } from '@/lib/db';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import { createConversationSchema } from '@/lib/validation';
import {
  assertNotBlocked,
  buildPresenceVisibility,
  messageInclude,
  serializeConversation,
  serializeMessage
} from '@/lib/serialize';
import { emitToUsers, joinUserToConversation } from '@/lib/realtime';
import { EVENTS } from '@shared/events';
import { maybeSendGreeting } from '@/lib/business-messaging';

export const dynamic = 'force-dynamic';

/** List my conversations (pinned first, then most recent activity). */
export const GET = withAuth(async (_req, user) => {
  const memberships = await db.conversationMember.findMany({
    where: { userId: user.id, leftAt: null },
    include: {
      conversation: {
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
      }
    },
    orderBy: [{ isPinned: 'desc' }, { conversation: { lastMessageAt: 'desc' } }]
  });

  const conversationIds = memberships.map((m) => m.conversationId);

  // Batched presence visibility for every member shown in the list.
  const allMemberIds = memberships.flatMap((m) =>
    m.conversation.members.map((mem) => mem.userId)
  );
  const presence = await buildPresenceVisibility(user.id, allMemberIds);

  // Latest message per conversation
  const lastMessages = await db.message.findMany({
    where: { conversationId: { in: conversationIds }, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    distinct: ['conversationId'],
    include: messageInclude,
    take: conversationIds.length
  });
  const lastByConv = new Map(lastMessages.map((m) => [m.conversationId, m]));

  // Unread counts — ONE grouped query for every membership (was N counts).
  // Baseline per member: messages after max(lastReadAt, joinedAt) so a late
  // group join never inherits pre-join history (joinedAt floor), and the read
  // cursor keeps working as before once it has advanced.
  const unreadMap = new Map<string, number>();
  if (conversationIds.length) {
    const rows = await db.$queryRaw<{ conversationId: string; unread: number }[]>`
      SELECT m."conversationId" AS "conversationId", COUNT(*)::int AS unread
      FROM "Message" m
      JOIN "ConversationMember" cm
        ON cm."conversationId" = m."conversationId"
       AND cm."userId" = ${user.id}
       AND cm."leftAt" IS NULL
      WHERE m."deletedAt" IS NULL
        AND m."senderId" <> ${user.id}
        AND m."conversationId" = ANY(${conversationIds}::text[])
        AND m."createdAt" > GREATEST(COALESCE(cm."lastReadAt", TO_TIMESTAMP(0)), cm."joinedAt")
      GROUP BY m."conversationId"
    `;
    for (const row of rows) unreadMap.set(row.conversationId, Number(row.unread) || 0);
  }

  const conversations = await Promise.all(
    memberships.map(async (m, i) => {
      const last = lastByConv.get(m.conversationId);
      return serializeConversation(m.conversation, user.id, {
        members: m.conversation.members,
        myMember: m,
        lastMessage: last ? serializeMessage(last, user.id) : null,
        unreadCount: unreadMap.get(m.conversationId) ?? 0,
        presence
      });
    })
  );

  return ok({ conversations });
});

/** Create a DIRECT (by username) or GROUP conversation. */
export const POST = withAuth(async (req, user) => {
  const body = createConversationSchema.parse(await readJson(req));

  if (body.type === 'DIRECT') {
    if (!body.username) throw new ApiError('VALIDATION_ERROR', 'A username is required.', 422);

    const peer = await db.user.findUnique({ where: { username: body.username.toLowerCase() } });
    if (!peer) throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
    if (peer.id === user.id) throw new ApiError('VALIDATION_ERROR', 'You cannot chat with yourself.', 422);
    await assertNotBlocked(user.id, peer.id);

    const messagePrivacy = (
      await db.userSettings.findUnique({
        where: { userId: peer.id },
        select: { privacyMessage: true }
      })
    )?.privacyMessage ?? 'EVERYONE';
    if (messagePrivacy !== 'EVERYONE') {
      const saved = await db.contact.findFirst({
        where: { ownerId: peer.id, contactId: user.id },
        select: { id: true }
      });
      if (messagePrivacy === 'NOBODY' || !saved) {
        const already = await db.conversation.findUnique({
          where: { directKey: [user.id, peer.id].sort().join(':') },
          select: { id: true }
        });
        if (!already) {
          throw new ApiError('FORBIDDEN', 'This person is not accepting new messages.', 403);
        }
      }
    }

    // Stable 1:1 key — reuses an existing direct conversation if present.
    const directKey = [user.id, peer.id].sort().join(':');

    const existing = await db.conversation.findUnique({
      where: { directKey },
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

    if (existing) {
      const myMember = existing.members.find((m) => m.userId === user.id)!;
      const last = await db.message.findFirst({
        where: { conversationId: existing.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: messageInclude
      });
      return ok({
        conversation: await serializeConversation(existing, user.id, {
          members: existing.members,
          myMember,
          lastMessage: last ? serializeMessage(last, user.id) : null,
          unreadCount: 0
        }),
        reused: true
      });
    }

    // Race-safe: if both users create the chat at the same instant, the
    // directKey unique constraint lets exactly one insert win — the loser
    // reuses the winner's conversation instead of failing or duplicating.
    let conversation;
    try {
      conversation = await db.conversation.create({
        data: {
          type: 'DIRECT',
          directKey,
          createdBy: user.id,
          members: {
            create: [{ userId: user.id }, { userId: peer.id }]
          }
        },
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
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== 'P2002') throw err;
      const winner = await db.conversation.findUnique({
        where: { directKey },
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
      if (!winner) throw err;
      const myMember = winner.members.find((m) => m.userId === user.id)!;
      const last = await db.message.findFirst({
        where: { conversationId: winner.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: messageInclude
      });
      return ok({
        conversation: await serializeConversation(winner, user.id, {
          members: winner.members,
          myMember,
          lastMessage: last ? serializeMessage(last, user.id) : null,
          unreadCount: 0
        }),
        reused: true
      });
    }

    try {
      await maybeSendGreeting(conversation.id, peer.id);
      await maybeSendGreeting(conversation.id, user.id);
    } catch {
      // A greeting failure must not block creating the chat.
    }
    const greeting = await db.message.findFirst({
      where: { conversationId: conversation.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: messageInclude
    });

    return ok(
      {
        conversation: await serializeConversation(conversation, user.id, {
          members: conversation.members,
          myMember: conversation.members.find((m) => m.userId === user.id)!,
          lastMessage: greeting ? serializeMessage(greeting, user.id) : null,
          unreadCount: 0
        })
      },
      { status: 201 }
    );
  }

  // GROUP
  const memberIds = Array.from(new Set([user.id, ...(body.memberIds ?? [])]));
  if (memberIds.length < 2) {
    throw new ApiError('VALIDATION_ERROR', 'Add at least one other member.', 422);
  }
  if (memberIds.length > 256) {
    throw new ApiError('VALIDATION_ERROR', 'Groups are limited to 256 members.', 422);
  }

  const valid = await db.user.count({
    where: { id: { in: memberIds.filter((id) => id !== user.id) }, status: { not: 'BANNED' } }
  });
  if (valid !== memberIds.length - 1) {
    throw new ApiError('USER_NOT_FOUND', 'One or more members could not be found.', 404);
  }

  const conversation = await db.conversation.create({
    data: {
      type: 'GROUP',
      title: body.title?.trim() || 'New Group',
      description: body.description?.trim() || null,
      createdBy: user.id,
      members: {
        create: memberIds.map((id) => ({
          userId: id,
          role: id === user.id ? 'ADMIN' : 'MEMBER'
        }))
      }
    },
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

  // System message announcing the group
  await db.message.create({
    data: {
      conversationId: conversation.id,
      senderId: user.id,
      type: 'SYSTEM',
      content: `${user.displayName} created the group “${conversation.title}”`
    }
  });

  // Instant realtime access for every initial member + notify the others.
  for (const uid of memberIds) joinUserToConversation(uid, conversation.id);
  const otherIds = memberIds.filter((uid) => uid !== user.id);
  if (otherIds.length) {
    emitToUsers(otherIds, EVENTS.CONVERSATION_UPDATED, {
      conversationId: conversation.id,
      added: true
    });
  }

  return ok(
    {
      conversation: await serializeConversation(conversation, user.id, {
        members: conversation.members,
        myMember: conversation.members.find((m) => m.userId === user.id)!,
        lastMessage: null,
        unreadCount: 0
      })
    },
    { status: 201 }
  );
});
