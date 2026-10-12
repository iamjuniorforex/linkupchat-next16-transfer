import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, ApiError } from '@/lib/api';
import { searchSchema } from '@/lib/validation';
import { canSeePrivacy } from '@/lib/serialize';
import { phoneMatchIds } from '@/lib/phone-search';
import type { UserDTO } from '@/types';

export const dynamic = 'force-dynamic';

/** Directory search by username, display name, email (exact) or phone (Section 11). */
export const GET = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'search', 60);
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  if (!q) throw new ApiError('VALIDATION_ERROR', 'Enter a search term.', 422);

  const term = q.toLowerCase();
  const emailQuery = q.includes('@') ? q.toLowerCase() : null;
  const contactRows = await db.contact.findMany({
    where: { ownerId: user.id },
    select: { contactId: true }
  });
  const contactIds = new Set(contactRows.map((c) => c.contactId));
  const exactPhoneIds = await phoneMatchIds(user.id, q, contactIds);

  const users = await db.user.findMany({
    where: {
      id: { not: user.id },
      status: { not: 'BANNED' },
      OR: [
        { username: { contains: term, mode: 'insensitive' } },
        { displayName: { contains: term, mode: 'insensitive' } },
        // Email is matched exactly only — substring matching would leak
        // who owns a given address. Phone is an exact full-number match
        // gated by privacyPhoneSearch, never a fragment.
        ...(emailQuery ? [{ email: emailQuery }] : []),
        ...(exactPhoneIds.length ? [{ id: { in: exactPhoneIds } }] : [])
      ]
    },
    take: 20,
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

  const blockedPairs = await db.blockedUser.findMany({
    where: {
      OR: [
        { blockerId: user.id },
        { blockedId: user.id }
      ]
    },
    select: { blockerId: true, blockedId: true }
  });
  const blockedIds = new Set(
    blockedPairs.map((b) => (b.blockerId === user.id ? b.blockedId : b.blockerId))
  );

  const results: UserDTO[] = users
    .filter((u) => !blockedIds.has(u.id))
    .map((u) => {
      const isContact = contactIds.has(u.id);
      const s = u.settings;
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        // Privacy-filtered card fields (same rules as the profile endpoint).
        avatarUrl: canSeePrivacy(s?.privacyProfilePhoto, isContact) ? u.avatarUrl : null,
        about: canSeePrivacy(s?.privacyAbout, isContact) ? u.about : '',
        isOnline: canSeePrivacy(s?.privacyOnline, isContact) ? u.isOnline : false,
        lastSeenAt: canSeePrivacy(s?.privacyLastSeen, isContact)
          ? u.lastSeenAt?.toISOString() ?? null
          : null,
        createdAt: u.createdAt.toISOString(),
        emailVerified: Boolean(u.emailVerifiedAt),
        isContact
      };
    });

  return ok({ users: results });
});
