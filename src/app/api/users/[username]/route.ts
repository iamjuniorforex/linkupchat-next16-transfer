import { db } from '@/lib/db';
import { withAuth, ok, fail } from '@/lib/api';
import { canSeePrivacy } from '@/lib/serialize';
import { accessFor } from '@/lib/billing';
import { badgeFor } from '@/lib/entitlements';
import { isSafeWebsite } from '@/lib/business-rules';
import type { UserDTO } from '@/types';

export const dynamic = 'force-dynamic';

/** Public profile view with privacy rules applied (Section 5). */
export const GET = withAuth(async (_req, user, ctx) => {
  const { username } = (ctx as { params: { username: string } }).params;

  const target = await db.user.findUnique({
    where: { username: username.toLowerCase() },
    include: { settings: true }
  });

  if (!target || target.status === 'BANNED') {
    return fail('USER_NOT_FOUND', 'User not found.', 404);
  }

  const viewer = await db.user.findUnique({
    where: { id: user.id },
    include: { settings: true }
  });

  const isSelf = target.id === user.id;
  const isContact = !isSelf
    ? Boolean(
        await db.contact.findFirst({
          where: { ownerId: user.id, contactId: target.id }
        })
      )
    : false;

  const blocked = await db.blockedUser.findFirst({
    where: {
      OR: [
        { blockerId: user.id, blockedId: target.id },
        { blockerId: target.id, blockedId: user.id }
      ]
    }
  });

  // Privacy helpers (shared with search + conversation serialization)
  const level = target.settings;
  const canSee = (setting: 'EVERYONE' | 'CONTACTS' | 'NOBODY') =>
    canSeePrivacy(setting, isContact, isSelf);

  const [access, business] = await Promise.all([
    accessFor(target.id),
    db.businessProfile.findUnique({ where: { userId: target.id } })
  ]);
  const badge = badgeFor(access.plan);

  const dto: UserDTO & { blockedByMe?: boolean; blockedMe?: boolean } = {
    id: target.id,
    username: target.username,
    displayName: target.displayName,
    avatarUrl: canSee(level?.privacyProfilePhoto ?? 'EVERYONE') ? target.avatarUrl : null,
    coverUrl: canSee(level?.privacyProfilePhoto ?? 'EVERYONE') ? target.coverUrl : null,
    accentColor: target.accentColor,
    about: canSee(level?.privacyAbout ?? 'EVERYONE') ? target.about : '',
    isOnline: canSee(level?.privacyOnline ?? 'EVERYONE') ? target.isOnline : false,
    lastSeenAt:
      canSee(level?.privacyLastSeen ?? 'EVERYONE') ? target.lastSeenAt?.toISOString() ?? null : null,
    createdAt: target.createdAt.toISOString(),
    emailVerified: Boolean(target.emailVerifiedAt),
    isContact,
    isBlocked: Boolean(blocked),
    blockedByMe: blocked?.blockerId === user.id,
    blockedMe: blocked?.blockerId === target.id,
    badge,
    businessVerified: badge === 'business' && business?.verificationStatus === 'APPROVED',
    businessName: badge === 'business' ? business?.name ?? null : null,
    businessWebsite:
      badge === 'business' && business?.website && isSafeWebsite(business.website) ? business.website : null
  };

  void viewer;
  return ok(dto);
});
