/**
 * Account deletion foundation (Phase 3, Part 6) — service boundary + the
 * deletion dependency graph, WITHOUT wiring a destructive endpoint.
 *
 * This module is intentionally the single place that knows HOW a user's data
 * is connected, so a future `DELETE /api/account` flow (with its product
 * decisions: message retention for other participants, moderation history,
 * grace periods) can execute against a tested plan instead of ad-hoc deletes.
 *
 * What the schema already guarantees on `DELETE FROM "User"` (Prisma
 * relations, see prisma/schema.prisma):
 *   CASCADE: sessions, password resets, verification tokens, login events,
 *            notifications, push subscriptions, user settings, contacts
 *            (both directions), blocks (both directions), conversation
 *            memberships, status rows (+ views), calls (either side),
 *            the user's reactions.
 *   SET NULL: message.senderId, attachment.uploaderId, report.reporterId
 *            (filed reports are RETAINED for moderation history),
 *            report.reportedUserId/resolvedById, conversation.createdBy,
 *            status.attachmentId.
 *
 * What is NOT automatic (explicit steps in the plan):
 *   - object-storage media cleanup for attachments only this user referenced
 *     (rows with `uploaderId = user` and `messageId = null` — the same
 *     exclusive-attachment rule the status/message cleanup already uses);
 *   - policy decisions listed as `policy` steps (kept visible, not silent).
 */
import { db } from '@/lib/db';
import { deleteStoredObject } from '@/lib/storage';
import { disconnectUserSockets } from '@/lib/realtime';

export type DeletionStepMode = 'cascade' | 'manual' | 'policy';

export interface DeletionStep {
  /** Execution order — lower runs first. */
  order: number;
  id: string;
  title: string;
  detail: string;
  mode: DeletionStepMode;
}

/**
 * The deletion dependency graph, in safe execution order. Pure and static —
 * unit-testable without a database. Storage cleanup MUST precede row deletes
 * that would lose the storageKey reference.
 */
export function accountDeletionPlan(): DeletionStep[] {
  return [
    {
      order: 1,
      id: 'freeze-visibility',
      title: 'Hide the account',
      detail:
        'Mark the user as leaving/deactivated so nothing new is addressed to them while deletion runs.',
      mode: 'policy'
    },
    {
      order: 2,
      id: 'collect-media',
      title: 'Collect exclusive media',
      detail:
        'List Attachment rows with uploaderId = user AND messageId = null (exclusive, never shared with a message or another status) plus their storageKeys.',
      mode: 'manual'
    },
    {
      order: 3,
      id: 'delete-status-media',
      title: 'Delete status media + statuses',
      detail:
        'Status rows cascade on user delete; exclusive attachments they reference must have their storage objects deleted first (same rule as runRetentionSweep).',
      mode: 'manual'
    },
    {
      order: 4,
      id: 'delete-exclusive-storage',
      title: 'Delete exclusive storage objects',
      detail:
        'deleteStoredObject for each exclusive storageKey. Shared attachments (messageId set, or referenced by a live status) are NEVER touched.',
      mode: 'manual'
    },
    {
      order: 5,
      id: 'anonymize-messages',
      title: 'Anonymize sent messages',
      detail:
        'Message.senderId becomes NULL (schema SET NULL) — message history survives for other participants.',
      mode: 'cascade'
    },
    {
      order: 6,
      id: 'revoke-sessions',
      title: 'Revoke sessions + sockets',
      detail:
        'Sessions cascade, and every live socket of the user must be disconnected (disconnectUserSockets).',
      mode: 'cascade'
    },
    {
      order: 7,
      id: 'delete-notifications',
      title: 'Delete notifications + push subscriptions',
      detail: 'Notification and PushSubscription rows cascade on user delete.',
      mode: 'cascade'
    },
    {
      order: 8,
      id: 'delete-social-graph',
      title: 'Delete contacts + blocks',
      detail: 'Contact and BlockedUser rows cascade in both directions.',
      mode: 'cascade'
    },
    {
      order: 9,
      id: 'delete-memberships',
      title: 'Delete conversation memberships',
      detail:
        'ConversationMember rows cascade. EMPTY direct conversations left behind are a policy decision (see next step).',
      mode: 'cascade'
    },
    {
      order: 10,
      id: 'empty-conversations',
      title: 'Decide empty-conversation policy',
      detail:
        'Direct conversations with zero remaining members: archive or hard-delete (deleting cascades their messages). Product decision required.',
      mode: 'policy'
    },
    {
      order: 11,
      id: 'delete-own-reactions',
      title: 'Delete the user’s reactions',
      detail: 'MessageReaction rows cascade.',
      mode: 'cascade'
    },
    {
      order: 12,
      id: 'reports-policy',
      title: 'Retain moderation history',
      detail:
        'DECIDED (Task 2): reports filed BY the user are retained for moderation — reporterId is SET NULL (anonymized) on user delete. Reports against them also keep the row with reportedUserId = NULL.',
      mode: 'policy'
    },
    {
      order: 13,
      id: 'delete-calls',
      title: 'Delete call rows',
      detail: 'Call rows cascade when either participant is deleted — losing the peer’s history. Policy decision whether to anonymize instead.',
      mode: 'policy'
    },
    {
      order: 14,
      id: 'delete-user-row',
      title: 'Delete the user row',
      detail:
        'DELETE FROM "User" — everything above is either already cleaned up (manual) or cascades safely (verified by tests).',
      mode: 'cascade'
    }
  ];
}

export interface AccountDeletionInventory {
  userId: string;
  counts: {
    sessions: number;
    notifications: number;
    pushSubscriptions: number;
    contacts: number;
    blocks: number;
    conversationMemberships: number;
    messagesSent: number;
    reactions: number;
    statuses: number;
    statusViews: number;
    calls: number;
    reportsFiled: number;
    loginEvents: number;
  };
  /** Attachments only this user referenced (uploader, not on any message). */
  exclusiveMedia: { attachmentId: string; storageKey: string; kind: string }[];
  /** Attachments this user uploaded that are SHARED (message-attached or
   * referenced by another live status) — their storage survives deletion. */
  sharedMediaCount: number;
}

/**
 * Count one user's data and classify their media for safe cleanup.
 * Scoped strictly by `userId` — never returns another user's rows.
 */
export async function accountDeletionInventory(userId: string): Promise<AccountDeletionInventory> {
  const [
    sessions,
    notifications,
    pushSubscriptions,
    contacts,
    blocks,
    conversationMemberships,
    messagesSent,
    reactions,
    statuses,
    statusViews,
    calls,
    reportsFiled,
    loginEvents,
    uploads
  ] = await Promise.all([
    db.session.count({ where: { userId } }),
    db.notification.count({ where: { userId } }),
    db.pushSubscription.count({ where: { userId } }),
    db.contact.count({ where: { OR: [{ ownerId: userId }, { contactId: userId }] } }),
    db.blockedUser.count({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] } }),
    db.conversationMember.count({ where: { userId } }),
    db.message.count({ where: { senderId: userId } }),
    db.messageReaction.count({ where: { userId } }),
    db.status.count({ where: { userId } }),
    db.statusView.count({ where: { viewerId: userId } }),
    db.call.count({ where: { OR: [{ callerId: userId }, { calleeId: userId }] } }),
    db.report.count({ where: { reporterId: userId } }),
    db.loginEvent.count({ where: { userId } }),
    db.attachment.findMany({
      where: { uploaderId: userId },
      select: {
        id: true,
        storageKey: true,
        kind: true,
        messageId: true,
        statuses: { where: { deletedAt: null }, select: { id: true, userId: true } }
      }
    })
  ]);

  const exclusiveMedia: AccountDeletionInventory['exclusiveMedia'] = [];
  let sharedMediaCount = 0;
  for (const a of uploads) {
    const sharedByMessage = a.messageId !== null;
    // A status reference shared with ANOTHER user's live status keeps the object.
    const sharedByOtherStatus = a.statuses.some((s) => s.userId !== userId);
    if (sharedByMessage || sharedByOtherStatus) {
      sharedMediaCount += 1;
    } else {
      exclusiveMedia.push({ attachmentId: a.id, storageKey: a.storageKey, kind: a.kind });
    }
  }

  return {
    userId,
    counts: {
      sessions,
      notifications,
      pushSubscriptions,
      contacts,
      blocks,
      conversationMemberships,
      messagesSent,
      reactions,
      statuses,
      statusViews,
      calls,
      reportsFiled,
      loginEvents
    },
    exclusiveMedia,
    sharedMediaCount
  };
}

export interface AccountDeletionResult {
  mediaObjectsDeleted: number;
  mediaObjectsFailed: number;
}

/**
 * Execute the deletion plan against a real account. Follows
 * accountDeletionPlan()'s ordering: exclusive media objects first (their
 * storage keys are only known while the rows exist), then live sockets, then
 * the user row — letting the schema's verified cascade / SET NULL rules finish
 * the job (sent messages survive for other participants, anonymized; shared
 * media, group conversations and other users' data are never touched).
 *
 * Storage cleanup is best-effort per object: an object whose deletion fails
 * keeps its Attachment row so a later sweep can retry instead of orphaning the
 * object — the account deletion itself always completes.
 */
export async function executeAccountDeletion(userId: string): Promise<AccountDeletionResult> {
  const inventory = await accountDeletionInventory(userId);

  // Plan steps 2–4: exclusive media only (never attached to a message and
  // never referenced by another user's live status).
  const cleanedIds: string[] = [];
  let mediaObjectsDeleted = 0;
  let mediaObjectsFailed = 0;
  for (const m of inventory.exclusiveMedia) {
    try {
      await deleteStoredObject(m.storageKey);
      cleanedIds.push(m.attachmentId);
      mediaObjectsDeleted += 1;
    } catch {
      mediaObjectsFailed += 1;
    }
  }
  if (cleanedIds.length > 0) {
    // Guard messageId = null again so a race can never delete shared media.
    await db.attachment.deleteMany({
      where: { id: { in: cleanedIds }, uploaderId: userId, messageId: null }
    });
  }

  // Plan step 6: kill every live socket before the session rows cascade away.
  disconnectUserSockets(userId);

  // Plan step 14: the user row. Everything else is prisma-documented cascade
  // or SET NULL — including message.senderId → NULL (anonymized history) and
  // attachment.uploaderId → NULL for shared media that must survive.
  // deleteMany keeps concurrent duplicate deletions idempotent: a second
  // in-flight request finds the row already gone and still succeeds.
  await db.user.deleteMany({ where: { id: userId } });

  return { mediaObjectsDeleted, mediaObjectsFailed };
}
