/**
 * Account data export foundation (Phase 3, Part 6).
 *
 * A versioned, read-only collector that assembles everything a user owns into
 * one JSON-serializable structure. Service boundary only — no HTTP endpoint
 * yet (the endpoint must decide delivery mechanics: streaming download vs
 * emailed archive; that is the documented remaining work).
 *
 * Privacy: strictly scoped to the requesting user's own data. Fields that
 * belong to OTHER people are minimized to what the user already sees in the
 * UI (display names of their contacts/peers, never emails/phones/tokens).
 */
import { db } from '@/lib/db';

export const ACCOUNT_EXPORT_VERSION = 1;

export interface AccountExport {
  version: number;
  exportedAt: string;
  profile: {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    phone: string | null;
    about: string;
    avatarUrl: string | null;
    role: string;
    status: string;
    emailVerifiedAt: string | null;
    createdAt: string;
  };
  settings: Record<string, unknown> | null;
  contacts: { contactId: string; username: string; displayName: string; nickname: string | null; since: string }[];
  blocked: { userId: string; username: string; displayName: string; since: string }[];
  conversations: {
    id: string;
    type: string;
    title: string | null;
    role: string;
    joinedAt: string;
    lastReadAt: string | null;
  }[];
  messages: {
    id: string;
    conversationId: string;
    type: string;
    content: string | null;
    createdAt: string;
    editedAt: string | null;
    deletedAt: string | null;
  }[];
  statuses: {
    id: string;
    type: string;
    content: string | null;
    createdAt: string;
    expiresAt: string;
  }[];
  attachments: {
    id: string;
    kind: string;
    fileName: string | null;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    createdAt: string;
  }[];
  reactions: { messageId: string; emoji: string; createdAt: string }[];
  notifications: { id: string; type: string; title: string; body: string | null; readAt: string | null; createdAt: string }[];
  reportsFiled: { id: string; category: string; status: string; createdAt: string }[];
  calls: { id: string; type: string; status: string; startedAt: string; durationSec: number }[];
  loginEvents: { id: string; ip: string | null; success: boolean; createdAt: string }[];
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Assemble the caller's full data export. Read-only — never mutates. */
export async function collectAccountExport(userId: string, now = new Date()): Promise<AccountExport> {
  const [user, settings, contacts, blocked, memberships, messages, statuses, uploads, reactions, notifications, reportsFiled, calls, loginEvents] =
    await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          phone: true,
          about: true,
          avatarUrl: true,
          role: true,
          status: true,
          emailVerifiedAt: true,
          createdAt: true
        }
      }),
      db.userSettings.findUnique({ where: { userId } }),
      db.contact.findMany({
        where: { ownerId: userId },
        select: {
          contactId: true,
          nickname: true,
          createdAt: true,
          contact: { select: { username: true, displayName: true } }
        }
      }),
      db.blockedUser.findMany({
        where: { blockerId: userId },
        select: {
          blockedId: true,
          createdAt: true,
          blocked: { select: { username: true, displayName: true } }
        }
      }),
      db.conversationMember.findMany({
        where: { userId },
        select: {
          conversationId: true,
          role: true,
          joinedAt: true,
          lastReadAt: true,
          conversation: { select: { type: true, title: true } }
        }
      }),
      db.message.findMany({
        where: { senderId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          conversationId: true,
          type: true,
          content: true,
          createdAt: true,
          editedAt: true,
          deletedAt: true
        }
      }),
      db.status.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, type: true, content: true, createdAt: true, expiresAt: true }
      }),
      db.attachment.findMany({
        where: { uploaderId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          storageKey: true,
          createdAt: true
        }
      }),
      db.messageReaction.findMany({
        where: { userId },
        select: { messageId: true, emoji: true, createdAt: true }
      }),
      db.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, type: true, title: true, body: true, readAt: true, createdAt: true }
      }),
      db.report.findMany({
        where: { reporterId: userId },
        select: { id: true, category: true, status: true, createdAt: true }
      }),
      db.call.findMany({
        where: { OR: [{ callerId: userId }, { calleeId: userId }] },
        orderBy: { startedAt: 'asc' },
        select: { id: true, type: true, status: true, startedAt: true, durationSec: true }
      }),
      db.loginEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, ip: true, success: true, createdAt: true }
      })
    ]);

  return {
    version: ACCOUNT_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    profile: {
      id: user!.id,
      username: user!.username,
      displayName: user!.displayName,
      email: user!.email,
      phone: user!.phone,
      about: user!.about,
      avatarUrl: user!.avatarUrl,
      role: user!.role,
      status: user!.status,
      emailVerifiedAt: iso(user!.emailVerifiedAt),
      createdAt: user!.createdAt.toISOString()
    },
    settings: settings ? (settings as unknown as Record<string, unknown>) : null,
    contacts: contacts.map((c) => ({
      contactId: c.contactId,
      username: c.contact.username,
      displayName: c.contact.displayName,
      nickname: c.nickname,
      since: c.createdAt.toISOString()
    })),
    blocked: blocked.map((b) => ({
      userId: b.blockedId,
      username: b.blocked.username,
      displayName: b.blocked.displayName,
      since: b.createdAt.toISOString()
    })),
    conversations: memberships.map((m) => ({
      id: m.conversationId,
      type: m.conversation.type,
      title: m.conversation.title,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
      lastReadAt: iso(m.lastReadAt)
    })),
    messages: messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      type: m.type,
      content: m.deletedAt ? null : m.content,
      createdAt: m.createdAt.toISOString(),
      editedAt: iso(m.editedAt),
      deletedAt: iso(m.deletedAt)
    })),
    statuses: statuses.map((s) => ({
      id: s.id,
      type: s.type,
      content: s.content,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString()
    })),
    attachments: uploads.map((a) => ({
      id: a.id,
      kind: a.kind,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      storageKey: a.storageKey,
      createdAt: a.createdAt.toISOString()
    })),
    reactions: reactions.map((r) => ({
      messageId: r.messageId,
      emoji: r.emoji,
      createdAt: r.createdAt.toISOString()
    })),
    notifications: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      readAt: iso(n.readAt),
      createdAt: n.createdAt.toISOString()
    })),
    reportsFiled: reportsFiled.map((r) => ({
      id: r.id,
      category: r.category,
      status: r.status,
      createdAt: r.createdAt.toISOString()
    })),
    calls: calls.map((c) => ({
      id: c.id,
      type: c.type,
      status: c.status,
      startedAt: c.startedAt.toISOString(),
      durationSec: c.durationSec
    })),
    loginEvents: loginEvents.map((l) => ({
      id: l.id,
      ip: l.ip,
      success: l.success,
      createdAt: l.createdAt.toISOString()
    }))
  };
}
