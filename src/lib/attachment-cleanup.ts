/**
 * Exclusive-attachment cleanup (audit remediation: "message delete leaves
 * media behind").
 *
 * Mirrors the safety model used by Status deletion (see
 * src/app/api/status/[id]/route.ts): an attachment is removed — DB row AND
 * storage object — only when NOTHING else legitimately references it. Anything
 * still shared is left untouched.
 *
 * An attachment is kept when it is:
 *   - still linked to a message (messageId not null),
 *   - referenced by any live (non-deleted) Status,
 *   - pointed at by a user avatar or group avatar URL.
 *
 * Cleanup order is storage-first, row-second and both steps are tolerant of
 * missing objects/rows, so a failed cleanup leaves consistent state and can be
 * retried safely. A cleanup failure NEVER fails the caller (message/status
 * deletion must succeed regardless).
 */
import { db } from './db';
import { deleteStoredObject } from './storage';

export async function isAttachmentReferencedElsewhere(attachmentId: string): Promise<boolean> {
  const attachment = await db.attachment.findUnique({ where: { id: attachmentId } });
  if (!attachment) return false;
  if (attachment.messageId !== null) return true;

  const statusRefs = await db.status.count({
    where: { attachmentId: attachment.id, deletedAt: null }
  });
  if (statusRefs > 0) return true;

  // Defensive: avatars/group avatars reference attachments by URL string
  // (kind AVATAR / GROUP_AVATAR in practice — check the strings anyway).
  const userRefs = await db.user.count({ where: { avatarUrl: attachment.url } });
  if (userRefs > 0) return true;
  const conversationRefs = await db.conversation.count({ where: { avatarUrl: attachment.url } });
  if (conversationRefs > 0) return true;

  return false;
}

/**
 * Delete an attachment's storage object + row when nothing else references it.
 * Idempotent: returns false (without error) when the attachment is still
 * referenced or already gone; true when this call removed it.
 */
export async function tryDeleteExclusiveAttachment(attachmentId: string): Promise<boolean> {
  try {
    const attachment = await db.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment) return true; // already cleaned up — nothing to do

    if (await isAttachmentReferencedElsewhere(attachmentId)) return false;

    // Storage first: deleteStoredObject treats already-missing objects as
    // success, so this ordering keeps the row only while a retry could still
    // remove the object.
    await deleteStoredObject(attachment.storageKey);
    await db.attachment.deleteMany({ where: { id: attachment.id } });
    return true;
  } catch {
    // Best-effort: never fail message/status deletion because of cleanup.
    return false;
  }
}
