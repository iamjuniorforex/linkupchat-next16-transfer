/**
 * Data-retention sweep (audit M-4).
 *
 * The application filters expired data at read time, but nothing ever pruned
 * it. This sweep hard-deletes records that are long past any use:
 *  - sessions expired more than 30 days ago
 *  - expired/used password resets and verification tokens older than 7 days
 *  - login events older than 180 days
 *  - statuses that expired or were deleted more than 7 days ago
 *    (cascades their StatusView rows; exclusive attachments are cleaned up
 *    exactly like the early-delete flow — never a shared one)
 *  - notifications (Phase 3, Part 5): READ rows older than 30 days and
 *    UNREAD rows older than 90 days (bounded retention — unread items are
 *    never touched before a generous 90-day window, read items clear sooner)
 *
 * Conservative windows on purpose: nothing a user could still interact with
 * is touched. Runs at server boot and every 6 hours (see server.ts).
 */
import { db } from '@/lib/db';
import { deleteStoredObject } from '@/lib/storage';

const DAY_MS = 24 * 60 * 60 * 1000;
export const STATUS_GRAVEYARD_MS = 7 * DAY_MS;
export const NOTIFICATION_READ_RETENTION_MS = 30 * DAY_MS;
export const NOTIFICATION_UNREAD_RETENTION_MS = 90 * DAY_MS;

/**
 * Pure retention cutoffs for notifications — shared by the sweep and its
 * tests so the windows are asserted, not implied.
 */
export function notificationRetentionCutoffs(now: Date = new Date()): {
  readBefore: Date;
  unreadBefore: Date;
} {
  return {
    readBefore: new Date(now.getTime() - NOTIFICATION_READ_RETENTION_MS),
    unreadBefore: new Date(now.getTime() - NOTIFICATION_UNREAD_RETENTION_MS)
  };
}

export interface RetentionSummary {
  sessions: number;
  passwordResets: number;
  verificationTokens: number;
  loginEvents: number;
  statuses: number;
  attachments: number;
  notifications: number;
}

export async function runRetentionSweep(now = new Date()): Promise<RetentionSummary> {
  const summary: RetentionSummary = {
    sessions: 0,
    passwordResets: 0,
    verificationTokens: 0,
    loginEvents: 0,
    statuses: 0,
    attachments: 0,
    notifications: 0
  };

  const sessions = await db.session.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - 30 * DAY_MS) } }
  });
  summary.sessions = sessions.count;

  const resets = await db.passwordReset.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
        { usedAt: { not: null }, createdAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } }
      ]
    }
  });
  summary.passwordResets = resets.count;

  const verifications = await db.verificationToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
        { usedAt: { not: null }, createdAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } }
      ]
    }
  });
  summary.verificationTokens = verifications.count;

  const logins = await db.loginEvent.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - 180 * DAY_MS) } }
  });
  summary.loginEvents = logins.count;

  // Notifications: read rows past 30 days, unread past 90 (both windows
  // generous — nothing a user could still act on is touched early).
  const { readBefore, unreadBefore } = notificationRetentionCutoffs(now);
  const notifications = await db.notification.deleteMany({
    where: {
      OR: [
        { readAt: { not: null }, createdAt: { lt: readBefore } },
        { readAt: null, createdAt: { lt: unreadBefore } }
      ]
    }
  });
  summary.notifications = notifications.count;

  // Statuses long past their 24h window (or deleted long ago).
  const graveyardCutoff = new Date(now.getTime() - STATUS_GRAVEYARD_MS);
  const staleStatuses = await db.status.findMany({
    where: {
      OR: [{ expiresAt: { lt: graveyardCutoff } }, { deletedAt: { lt: graveyardCutoff } }]
    },
    select: { id: true, attachmentId: true }
  });

  for (const status of staleStatuses) {
    if (status.attachmentId) {
      const attachment = await db.attachment.findUnique({ where: { id: status.attachmentId } });
      if (attachment) {
        const referencedElsewhere =
          attachment.messageId !== null ||
          (await db.status.count({
            where: { attachmentId: attachment.id, id: { not: status.id }, deletedAt: null }
          })) > 0;
        if (!referencedElsewhere) {
          await db.attachment
            .delete({ where: { id: attachment.id } })
            .then(() => deleteStoredObject(attachment.storageKey))
            .catch(() => {});
          summary.attachments += 1;
        }
      }
    }
    // Hard delete — StatusView rows cascade.
    await db.status.delete({ where: { id: status.id } }).catch(() => {});
    summary.statuses += 1;
  }

  return summary;
}
