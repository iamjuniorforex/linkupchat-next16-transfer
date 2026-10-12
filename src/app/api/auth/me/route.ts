import { db } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { ok, fail } from '@/lib/api';
import { accessFor } from '@/lib/billing';
import { badgeFor } from '@/lib/entitlements';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail('UNAUTHORIZED', 'Not logged in.', 401);

  const [settings, profile, access, business] = await Promise.all([
    db.userSettings.findUnique({ where: { userId: user.id } }),
    db.user.findUnique({ where: { id: user.id }, select: { coverUrl: true, accentColor: true } }),
    accessFor(user.id),
    db.businessProfile.findUnique({
      where: { userId: user.id },
      select: { verificationStatus: true, name: true }
    })
  ]);
  const badge = badgeFor(access.plan);

  return ok({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    coverUrl: profile?.coverUrl ?? null,
    accentColor: profile?.accentColor ?? null,
    about: user.about,
    role: user.role,
    status: user.status,
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    isOnline: true,
    badge,
    businessVerified: badge === 'business' && business?.verificationStatus === 'APPROVED',
    businessName: badge === 'business' ? business?.name ?? null : null,
    settings: settings ?? {
      theme: 'SYSTEM',
      enterToSend: true,
      mediaAutoDownload: true,
      wallpaper: 'default',
      notifMessages: true,
      notifGroups: true,
      notifCalls: true,
      notifSounds: true,
      notifPreview: true,
      notifEnabled: true,
      notifStatus: true,
      privacyLastSeen: 'EVERYONE',
      privacyOnline: 'EVERYONE',
      privacyProfilePhoto: 'EVERYONE',
      privacyAbout: 'EVERYONE',
      privacyStatus: 'CONTACTS',
      privacyReadReceipts: true,
      privacyPhoneSearch: 'NOBODY',
      privacyAddMe: 'EVERYONE',
      privacyMessage: 'EVERYONE',
      privacyDiscover: 'EVERYONE'
    }
  });
}
