/**
 * Phase 5B — status visibility rules.
 *
 * Single place that decides which statuses a viewer may see, so later phases
 * (per-status audience, close friends, etc.) can expand privacy in one spot.
 *
 * Current rules:
 *  - expired or soft-deleted statuses are never visible (server-enforced);
 *  - a viewer always sees their own active statuses;
 *  - otherwise the author's privacyStatus setting applies
 *    (EVERYONE / CONTACTS = viewer is in the author's contact list per the
 *    viewer's own contacts, matching canSeePrivacy / NOBODY = never);
 *  - anyone in a block relationship with the viewer is never visible.
 */
import type { Prisma, StatusAudience } from '@prisma/client';
import { db } from '@/lib/db';
import { audienceAllows, type StatusAudienceMode } from '@/lib/status-stories';

/** Active = not deleted, not archived, and not expired. */
export function activeStatusWhere(now = new Date()): Prisma.StatusWhereInput {
  return { deletedAt: null, archivedAt: null, expiresAt: { gt: now } };
}

/** Author-only archive: expired or explicitly archived, never deleted. */
export function archivedStatusWhere(now = new Date()): Prisma.StatusWhereInput {
  return {
    deletedAt: null,
    OR: [{ archivedAt: { not: null } }, { expiresAt: { lte: now } }]
  };
}

/** The viewer's contact ids and the ids of anyone in a block relationship. */
export async function statusAudienceFor(viewerId: string): Promise<{
  contactIds: string[];
  blockedIds: string[];
}> {
  const [contacts, blocks] = await Promise.all([
    db.contact.findMany({ where: { ownerId: viewerId }, select: { contactId: true } }),
    db.blockedUser.findMany({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      select: { blockerId: true, blockedId: true }
    })
  ]);
  return {
    contactIds: contacts.map((c) => c.contactId),
    blockedIds: blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId))
  };
}

/**
 * Visibility scope for `viewerId` inside `db.status.findMany`. `contactIds` /
 * `blockedIds` come from `statusAudienceFor` (Prisma where-clauses cannot
 * subquery the viewer's lists).
 */
export function visibleStatusWhere(
  viewerId: string,
  contactIds: string[],
  blockedIds: string[]
): Prisma.StatusWhereInput {
  return {
    AND: [
      activeStatusWhere(),
      { userId: { notIn: blockedIds } },
      {
        OR: [
          { userId: viewerId },
          {
            userId: { in: contactIds },
            user: { settings: { privacyStatus: { in: ['EVERYONE', 'CONTACTS'] } } }
          },
          { user: { settings: { privacyStatus: 'EVERYONE' } } }
        ]
      }
    ]
  };
}

export type StatusVisibilityRow = {
  id: string;
  userId: string;
  deletedAt: Date | null;
  archivedAt: Date | null;
  expiresAt: Date;
  audience: StatusAudience;
  audienceMembers: { userId: string }[];
};

/**
 * Server-side visibility for one status. Returns null when the viewer must
 * not learn that the row exists (expired, deleted, blocked, wrong audience).
 * The author can still read an expired or archived row; everyone else cannot.
 */
export async function loadStatusForViewer(
  viewerId: string,
  statusId: string
): Promise<{ status: StatusVisibilityRow; active: boolean } | null> {
  const status = await db.status.findUnique({
    where: { id: statusId },
    include: { audienceMembers: { select: { userId: true } } }
  });
  if (!status || status.deletedAt) return null;
  const active = !status.archivedAt && status.expiresAt > new Date();
  if (status.userId === viewerId) return { status, active };
  if (!active) return null;

  const { contactIds, blockedIds } = await statusAudienceFor(viewerId);
  if (blockedIds.includes(status.userId)) return null;
  const level = (
    await db.userSettings.findUnique({
      where: { userId: status.userId },
      select: { privacyStatus: true }
    })
  )?.privacyStatus;
  const isContact = contactIds.includes(status.userId);
  const accountOk = level === 'EVERYONE' || (level === 'CONTACTS' && isContact);
  if (!accountOk) return null;
  if (
    !audienceAllows({
      viewerId,
      authorId: status.userId,
      audience: status.audience as StatusAudienceMode,
      memberIds: status.audienceMembers.map((m) => m.userId)
    })
  ) {
    return null;
  }
  return { status, active: true };
}
