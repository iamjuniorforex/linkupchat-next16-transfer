import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, ApiError } from '@/lib/api';
import type { ConversationDTO, MessageDTO, UserDTO } from '@/types';
import { messageInclude, serializeMessage, canSeePrivacy } from '@/lib/serialize';
import { phoneMatchIds } from '@/lib/phone-search';

export const dynamic = 'force-dynamic';

/** Global search: users, conversations and message history (Section 12). */
export const GET = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'search', 60);
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const scope = url.searchParams.get('scope') ?? 'all'; // all | users | chats | messages
  if (!q) throw new ApiError('VALIDATION_ERROR', 'Enter a search term.', 422);
  if (q.length > 120) throw new ApiError('VALIDATION_ERROR', 'Search term is too long.', 422);

  const term = q.toLowerCase();
  const contactRows = await db.contact.findMany({
    where: { ownerId: user.id },
    select: { contactId: true }
  });
  const contactIds = new Set(contactRows.map((c) => c.contactId));

  // Users
  let users: UserDTO[] = [];
  if (scope === 'all' || scope === 'users') {
    const blockedPairs = await db.blockedUser.findMany({
      where: { OR: [{ blockerId: user.id }, { blockedId: user.id }] },
      select: { blockerId: true, blockedId: true }
    });
    const blockedIds = new Set(
      blockedPairs.map((b) => (b.blockerId === user.id ? b.blockedId : b.blockerId))
    );
    const exactPhoneIds = await phoneMatchIds(user.id, q, contactIds);
    const rows = await db.user.findMany({
      where: {
        id: { not: user.id },
        status: { not: 'BANNED' },
        OR: [
          { username: { contains: term, mode: 'insensitive' } },
          { displayName: { contains: term, mode: 'insensitive' } },
          ...(exactPhoneIds.length ? [{ id: { in: exactPhoneIds } }] : [])
        ]
      },
      take: 8,
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        about: true,
        isOnline: true,
        lastSeenAt: true,
        createdAt: true,
        emailVerifiedAt: true,
        settings: {
          select: {
            privacyProfilePhoto: true,
            privacyAbout: true,
            privacyOnline: true,
            privacyLastSeen: true
          }
        }
      }
    });

    users = rows
      .filter((u) => !blockedIds.has(u.id))
      .map((u) => {
        const isContact = contactIds.has(u.id);
        const s = u.settings;
        return {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatarUrl: canSeePrivacy(s?.privacyProfilePhoto, isContact) ? u.avatarUrl : null,
          about: canSeePrivacy(s?.privacyAbout, isContact) ? u.about : '',
          isOnline: canSeePrivacy(s?.privacyOnline, isContact) ? u.isOnline : false,
          lastSeenAt: canSeePrivacy(s?.privacyLastSeen, isContact)
            ? u.lastSeenAt?.toISOString() ?? null
            : null,
          createdAt: u.createdAt.toISOString(),
          emailVerified: Boolean(u.emailVerifiedAt)
        };
      });
  }

  // Conversations (by title or peer name)
  let conversations: ConversationDTO[] = [];
  if (scope === 'all' || scope === 'chats') {
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
                    about: true,
                    settings: {
                      select: {
                        privacyProfilePhoto: true,
                        privacyAbout: true,
                        privacyOnline: true,
                        privacyLastSeen: true
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const matched = memberships.filter((m) => {
      const t = m.conversation.title?.toLowerCase() ?? '';
      const peer = m.conversation.members.find((x) => x.userId !== user.id);
      return (
        t.includes(term) ||
        peer?.user.displayName.toLowerCase().includes(term) ||
        peer?.user.username.includes(term)
      );
    });

    conversations = matched.slice(0, 8).map((m) => ({
      id: m.conversation.id,
      type: m.conversation.type as 'DIRECT' | 'GROUP',
      title: m.conversation.title,
      description: m.conversation.description,
      avatarUrl: m.conversation.avatarUrl,
      memberCount: m.conversation.members.length,
      members: [],
      peer:
        m.conversation.type === 'DIRECT'
          ? m.conversation.members
              .filter((x) => x.userId !== user.id)
              .map((x) => {
                const s = x.user.settings;
                const isContact = contactIds.has(x.user.id);
                return {
                  id: x.user.id,
                  username: x.user.username,
                  displayName: x.user.displayName,
                  avatarUrl: canSeePrivacy(s?.privacyProfilePhoto, isContact) ? x.user.avatarUrl : null,
                  isOnline: canSeePrivacy(s?.privacyOnline, isContact) ? x.user.isOnline : false,
                  lastSeenAt: canSeePrivacy(s?.privacyLastSeen, isContact)
                    ? x.user.lastSeenAt?.toISOString() ?? null
                    : null,
                  about: canSeePrivacy(s?.privacyAbout, isContact) ? x.user.about : ''
                };
              })[0] ?? null
          : null,
      lastMessage: null,
      unreadCount: 0,
      isMuted: m.isMuted,
      isPinned: m.isPinned,
      isArchived: m.isArchived,
      lastReadMessageId: m.lastReadMessageId,
      createdAt: m.conversation.createdAt.toISOString(),
      lastMessageAt: m.conversation.lastMessageAt?.toISOString() ?? null,
      myRole: m.role as 'MEMBER' | 'ADMIN'
    }));
  }

  // Message history across my conversations
  let messages: MessageDTO[] = [];
  if (scope === 'all' || scope === 'messages') {
    const myConvs = await db.conversationMember.findMany({
      where: { userId: user.id, leftAt: null },
      select: { conversationId: true }
    });

    const rows = await db.message.findMany({
      where: {
        conversationId: { in: myConvs.map((c) => c.conversationId) },
        deletedAt: null,
        content: { contains: term, mode: 'insensitive' }
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: messageInclude
    });

    messages = rows.map((m) => serializeMessage(m, user.id));
  }

  return ok({ users, conversations, messages, query: q });
});
