import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok } from '@/lib/api';
import { canSeePrivacy } from '@/lib/serialize';
import type { UserDTO } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * People you may know: contacts of your contacts.
 * No phone numbers, emails, or accounts that opted out of discovery.
 */
export const GET = withAuth(async (_req, user) => {
  enforceUserRateLimit(user.id, 'discover', 30);
  const mine = await db.contact.findMany({
    where: { ownerId: user.id },
    select: { contactId: true }
  });
  const myIds = mine.map((row) => row.contactId);
  if (!myIds.length) return ok({ users: [] });

  const second = await db.contact.findMany({
    where: { ownerId: { in: myIds }, contactId: { notIn: [...myIds, user.id] } },
    select: { contactId: true },
    take: 80
  });
  const counts = new Map<string, number>();
  for (const row of second) counts.set(row.contactId, (counts.get(row.contactId) ?? 0) + 1);
  const candidateIds = [...counts.keys()];
  if (!candidateIds.length) return ok({ users: [] });

  const [blocked, people] = await Promise.all([
    db.blockedUser.findMany({
      where: {
        OR: [
          { blockerId: user.id, blockedId: { in: candidateIds } },
          { blockedId: user.id, blockerId: { in: candidateIds } }
        ]
      },
      select: { blockerId: true, blockedId: true }
    }),
    db.user.findMany({
      where: { id: { in: candidateIds }, status: { not: 'BANNED' } },
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
            privacyDiscover: true,
            privacyProfilePhoto: true,
            privacyAbout: true,
            privacyOnline: true,
            privacyLastSeen: true
          }
        }
      }
    })
  ]);
  const blockedIds = new Set(blocked.map((row) => (row.blockerId === user.id ? row.blockedId : row.blockerId)));

  const users: (UserDTO & { mutualCount: number })[] = people
    .filter((person) => !blockedIds.has(person.id))
    .filter((person) => {
      const level = person.settings?.privacyDiscover ?? 'EVERYONE';
      return level === 'EVERYONE';
    })
    .map((person) => {
      const s = person.settings;
      return {
        id: person.id,
        username: person.username,
        displayName: person.displayName,
        avatarUrl: canSeePrivacy(s?.privacyProfilePhoto, false) ? person.avatarUrl : null,
        about: canSeePrivacy(s?.privacyAbout, false) ? person.about : '',
        isOnline: canSeePrivacy(s?.privacyOnline, false) ? person.isOnline : false,
        lastSeenAt: canSeePrivacy(s?.privacyLastSeen, false) ? person.lastSeenAt?.toISOString() ?? null : null,
        createdAt: person.createdAt.toISOString(),
        emailVerified: Boolean(person.emailVerifiedAt),
        mutualCount: counts.get(person.id) ?? 0
      };
    })
    .sort((a, b) => b.mutualCount - a.mutualCount)
    .slice(0, 12);

  return ok({ users });
});
