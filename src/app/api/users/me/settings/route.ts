import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { settingsSchema } from '@/lib/validation';
import { isWallpaper } from '@/lib/wallpapers';
import { isPremiumWallpaper } from '@/lib/plans';
import { accessFor } from '@/lib/billing';
import { hasEntitlement } from '@/lib/entitlements';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  const settings = await db.userSettings.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id }
  });
  return ok(settings);
});

export const PATCH = withAuth(async (req, user) => {
  const body = settingsSchema.parse(await req.json().catch(() => ({})));
  if (body.wallpaper !== undefined) {
    if (!isWallpaper(body.wallpaper)) {
      throw new ApiError('VALIDATION_ERROR', 'Unknown wallpaper.', 400);
    }
    if (isPremiumWallpaper(body.wallpaper)) {
      const access = await accessFor(user.id);
      if (!hasEntitlement(access.plan, 'premium.themes')) {
        throw new ApiError('FORBIDDEN', 'This wallpaper is a Premium feature.', 403);
      }
    }
  }

  const settings = await db.userSettings.upsert({
    where: { userId: user.id },
    update: body,
    create: { userId: user.id, ...body }
  });

  return ok(settings);
});
