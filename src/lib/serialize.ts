import { db } from './db';
import { ApiError } from './api';
import type {
  ConversationDTO,
  MessageDTO,
  ReactionDTO,
  UserDTO,
  AttachmentDTO
} from '../types';

type MessageWithRelations = {
  id: string;
  conversationId: string;
  senderId: string | null;
  type: string;
  content: string | null;
  clientNonce: string | null;
  replyToId: string | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt?: Date;
  sender?: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  replyTo?: {
    id: string;
    content: string | null;
    type: string;
    senderId: string | null;
    deletedAt?: Date | null;
    sender?: { displayName: string | null } | null;
  } | null;
  attachments?: {
    id: string;
    kind: string;
    url: string;
    thumbnailUrl: string | null;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    fileName: string | null;
  }[];
  reactions?: { emoji: string; userId: string }[];
};

export function serializeAttachment(a: NonNullable<MessageWithRelations['attachments']>[number]): AttachmentDTO {
  return {
    id: a.id,
    kind: a.kind,
    url: a.url,
    thumbnailUrl: a.thumbnailUrl,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    fileName: a.fileName
  };
}

export function serializeMessage(
  m: MessageWithRelations,
  currentUserId: string,
  opts: {
    readBy?: string[];
    status?: 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  } = {}
): MessageDTO {
  const reactionMap = new Map<string, ReactionDTO>();
  for (const r of m.reactions ?? []) {
    const entry = reactionMap.get(r.emoji) ?? {
      emoji: r.emoji,
      count: 0,
      userIds: [],
      reacted: false
    };
    entry.count += 1;
    entry.userIds.push(r.userId);
    if (r.userId === currentUserId) entry.reacted = true;
    reactionMap.set(r.emoji, entry);
  }

  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    sender: m.sender
      ? {
          id: m.sender.id,
          username: m.sender.username,
          displayName: m.sender.displayName,
          avatarUrl: m.sender.avatarUrl
        }
      : null,
    type: m.type as MessageDTO['type'],
    content: m.deletedAt ? null : m.content,
    clientNonce: m.clientNonce,
    replyToId: m.replyToId,
    replyTo: m.replyTo
      ? {
          id: m.replyTo.id,
          content: m.replyTo.deletedAt ? null : m.replyTo.content,
          type: m.replyTo.type as MessageDTO['type'],
          senderName: m.replyTo.sender?.displayName ?? null,
          senderId: m.replyTo.senderId,
          deletedAt: !!m.replyTo.deletedAt
        }
      : null,
    attachments: (m.attachments ?? []).map(serializeAttachment),
    reactions: Array.from(reactionMap.values()),
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
    pinnedAt: m.pinnedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: (m.updatedAt ?? m.editedAt ?? m.createdAt).toISOString(),
    status: opts.status ?? 'SENT',
    readBy: opts.readBy ?? [],
    isMine: m.senderId === currentUserId
  };
}

/**
 * Derives the delivery status the VIEWER sees for a message, from member
 * delivery/read cursors.
 *
 * READ       — every other active member has seen it (respecting read-receipt
 *              privacy: a member with privacyReadReceipts=false neither sends
 *              nor sees read receipts — symmetric, as documented in Settings)
 * DELIVERED  — at least one other member's client received it (delivered
 *              cursor at/after the message, or they read it)
 * SENT       — persisted and fanned out
 */
export async function deriveMessageStatus(
  message: { id: string; senderId: string | null; createdAt: Date; conversationId: string },
  memberReads: {
    userId: string;
    lastReadAt: Date | null;
    lastDeliveredAt: Date | null;
    leftAt: Date | null;
    privacyReadReceipts?: boolean;
  }[],
  viewerId: string
): Promise<{ status: 'SENT' | 'DELIVERED' | 'READ'; readBy: string[] }> {
  const others = memberReads.filter((m) => m.userId !== message.senderId && !m.leftAt);
  const viewer = memberReads.find((m) => m.userId === viewerId);
  const viewerHidesReceipts = viewer?.privacyReadReceipts === false;

  const seenBy = (m: (typeof others)[number]) =>
    Boolean(m.lastReadAt && m.lastReadAt >= message.createdAt);
  const deliveredTo = (m: (typeof others)[number]) =>
    Boolean(
      (m.lastDeliveredAt && m.lastDeliveredAt >= message.createdAt) || seenBy(m)
    );

  // Read receipts are hidden both ways when either side turned them off.
  const readable = viewerHidesReceipts
    ? []
    : others.filter((m) => m.privacyReadReceipts !== false && seenBy(m));
  const readBy = readable.map((m) => m.userId);

  const deliveredCount = others.filter(deliveredTo).length;

  if (readable.length > 0 && readable.length === others.filter((m) => m.privacyReadReceipts !== false).length) {
    return { status: 'READ', readBy };
  }
  if (deliveredCount > 0 || readBy.length > 0) {
    return { status: 'DELIVERED', readBy };
  }
  return { status: 'SENT', readBy };
}

/** Privacy gate shared by profiles, search and conversation serialization. */
export function canSeePrivacy(
  level: 'EVERYONE' | 'CONTACTS' | 'NOBODY' | undefined,
  isContact: boolean,
  isSelf = false
): boolean {
  const setting = level ?? 'EVERYONE';
  return isSelf || setting === 'EVERYONE' || (setting === 'CONTACTS' && isContact);
}

export interface PresenceVisibility {
  online: boolean;
  lastSeen: boolean;
}

/**
 * Computes, per user, whether the VIEWER may see their online status and
 * last-seen time (privacyOnline / privacyLastSeen + contact relationship).
 * Uses the same semantics as the profile endpoint.
 */
export async function buildPresenceVisibility(
  viewerId: string,
  userIds: string[]
): Promise<Map<string, PresenceVisibility>> {
  const out = new Map<string, PresenceVisibility>();
  const ids = Array.from(new Set(userIds.filter((id) => id && id !== viewerId)));
  if (!ids.length) return out;

  const [settings, contacts] = await Promise.all([
    db.userSettings.findMany({
      where: { userId: { in: ids } },
      select: {
        userId: true,
        privacyOnline: true,
        privacyLastSeen: true
      }
    }),
    db.contact.findMany({
      where: { ownerId: viewerId, contactId: { in: ids } },
      select: { contactId: true }
    })
  ]);

  const settingMap = new Map(settings.map((s) => [s.userId, s]));
  const contactIds = new Set(contacts.map((c) => c.contactId));

  for (const id of ids) {
    const s = settingMap.get(id);
    out.set(id, {
      online: canSeePrivacy(s?.privacyOnline, contactIds.has(id)),
      lastSeen: canSeePrivacy(s?.privacyLastSeen, contactIds.has(id))
    });
  }
  return out;
}

export interface AccessContext {
  memberId: string;
  role: 'MEMBER' | 'ADMIN';
  conversation: {
    id: string;
    type: 'DIRECT' | 'GROUP';
    title: string | null;
    description: string | null;
    avatarUrl: string | null;
    createdBy: string | null;
    directKey: string | null;
    onlyAdminsMessage: boolean;
    onlyAdminsEditInfo: boolean;
    onlyAdminsAddMembers: boolean;
    createdAt: Date;
    lastMessageAt: Date | null;
  };
}

/** Authorization gate for every conversation-scoped operation. */
export async function requireConversationAccess(
  userId: string,
  conversationId: string
): Promise<AccessContext> {
  const member = await db.conversationMember.findFirst({
    where: { conversationId, userId, leftAt: null },
    include: { conversation: true }
  });

  if (!member) {
    throw new ApiError('FORBIDDEN', 'You do not have access to this conversation.', 403);
  }

  return {
    memberId: member.id,
    role: member.role as 'MEMBER' | 'ADMIN',
    conversation: {
      id: member.conversation.id,
      type: member.conversation.type as 'DIRECT' | 'GROUP',
      title: member.conversation.title,
      description: member.conversation.description,
      avatarUrl: member.conversation.avatarUrl,
      createdBy: member.conversation.createdBy,
      directKey: member.conversation.directKey,
      onlyAdminsMessage: member.conversation.onlyAdminsMessage,
      onlyAdminsEditInfo: member.conversation.onlyAdminsEditInfo,
      onlyAdminsAddMembers: member.conversation.onlyAdminsAddMembers,
      createdAt: member.conversation.createdAt,
      lastMessageAt: member.conversation.lastMessageAt
    }
  };
}

export async function assertNotBlocked(userId: string, otherId: string) {
  const block = await db.blockedUser.findFirst({
    where: {
      OR: [
        { blockerId: userId, blockedId: otherId },
        { blockerId: otherId, blockedId: userId }
      ]
    }
  });
  if (block) {
    throw new ApiError(
      'BLOCKED',
      block.blockerId === userId
        ? 'You have blocked this user. Unblock them to start chatting.'
        : 'You cannot message this user.',
      403
    );
  }
}

export function serializeUserMinimal(u: {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isOnline: boolean;
  lastSeenAt: Date | null;
}): UserDTO {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    about: '',
    isOnline: u.isOnline,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
    createdAt: '',
    emailVerified: true
  };
}

export async function serializeConversation(
  conversation: {
    id: string;
    type: string;
    title: string | null;
    description: string | null;
    avatarUrl: string | null;
    createdAt: Date;
    lastMessageAt: Date | null;
    onlyAdminsMessage?: boolean;
    onlyAdminsEditInfo?: boolean;
    onlyAdminsAddMembers?: boolean;
  },
  currentUserId: string,
  extras: {
    members?: {
      userId: string;
      role: string;
      joinedAt: Date;
      user: {
        id: string;
        username: string;
        displayName: string;
        avatarUrl: string | null;
        isOnline: boolean;
        lastSeenAt: Date | null;
        about: string;
      };
    }[];
    myMember: {
      isMuted: boolean;
      isPinned: boolean;
      isArchived: boolean;
      lastReadAt: Date | null;
      lastReadMessageId: string | null;
      role: string;
    };
    lastMessage?: MessageDTO | null;
    unreadCount: number;
    /**
     * Per-user presence visibility for the viewer (from
     * buildPresenceVisibility). Computed automatically when omitted.
     */
    presence?: Map<string, PresenceVisibility>;
  }
): Promise<ConversationDTO> {
  const members = extras.members ?? [];
  const other = members.find((m) => m.userId !== currentUserId);
  // Caller may pass a prebuilt map (batched endpoints); otherwise compute here.
  const presence =
    extras.presence ??
    (await buildPresenceVisibility(currentUserId, members.map((m) => m.userId)));

  const visiblePresence = (userId: string, isOnline: boolean, lastSeenAt: Date | null) => {
    const vis = presence?.get(userId);
    return {
      isOnline: vis?.online ? isOnline : false,
      lastSeenAt: vis?.lastSeen ? lastSeenAt?.toISOString() ?? null : null
    };
  };

  return {
    id: conversation.id,
    type: conversation.type as 'DIRECT' | 'GROUP',
    title: conversation.title,
    description: conversation.description,
    avatarUrl: conversation.avatarUrl,
    memberCount: members.filter((m) => true).length,
    members: members.map((m) => {
      const p = visiblePresence(m.userId, m.user.isOnline, m.user.lastSeenAt);
      return {
        userId: m.userId,
        role: m.role as 'MEMBER' | 'ADMIN',
        joinedAt: m.joinedAt.toISOString(),
        // D4: whether the VIEWER may change this member's role/membership
        // (group admins manage others; self-management is "Leave group").
        canManageMembers:
          conversation.type === 'GROUP' &&
          extras.myMember.role === 'ADMIN' &&
          m.userId !== currentUserId,
        user: {
          id: m.user.id,
          username: m.user.username,
          displayName: m.user.displayName,
          avatarUrl: m.user.avatarUrl,
          isOnline: p.isOnline,
          lastSeenAt: p.lastSeenAt
        }
      };
    }),
    peer:
      conversation.type === 'DIRECT' && other
        ? (() => {
            const p = visiblePresence(other.user.id, other.user.isOnline, other.user.lastSeenAt);
            return {
              id: other.user.id,
              username: other.user.username,
              displayName: other.user.displayName,
              avatarUrl: other.user.avatarUrl,
              isOnline: p.isOnline,
              lastSeenAt: p.lastSeenAt,
              about: other.user.about
            };
          })()
        : null,
    lastMessage: extras.lastMessage ?? null,
    unreadCount: extras.unreadCount,
    isMuted: extras.myMember.isMuted,
    isPinned: extras.myMember.isPinned,
    isArchived: extras.myMember.isArchived,
    lastReadMessageId: extras.myMember.lastReadMessageId,
    createdAt: conversation.createdAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    onlyAdminsMessage: conversation.onlyAdminsMessage ?? false,
    onlyAdminsEditInfo: conversation.onlyAdminsEditInfo ?? false,
    onlyAdminsAddMembers: conversation.onlyAdminsAddMembers ?? false,
    myRole: extras.myMember.role as 'MEMBER' | 'ADMIN'
  };
}

export const messageInclude = {
  sender: {
    select: { id: true, username: true, displayName: true, avatarUrl: true }
  },
  replyTo: {
    select: {
      id: true,
      content: true,
      type: true,
      senderId: true,
      deletedAt: true,
      sender: { select: { displayName: true } }
    }
  },
  attachments: true,
  reactions: { select: { emoji: true, userId: true } }
} as const;
