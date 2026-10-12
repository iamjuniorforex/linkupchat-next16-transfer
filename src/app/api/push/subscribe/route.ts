import { db } from '@/lib/db';
import { withAuth, ok, readJson, ApiError } from '@/lib/api';
import { pushSubscriptionSchema, pushUnsubscribeSchema } from '@/lib/validation';
import { getPublicVapidKey, getVapidStatus } from '@/lib/push';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Safety bound — a user's devices can never grow storage unbounded. */
const MAX_SUBSCRIPTIONS_PER_USER = 10;

/**
 * Current user's push subscriptions + server push capability.
 * Only the owner ever sees their own rows (enforced by `userId` scoping).
 * `configuredReason` is a SAFE diagnostic ('ok' / 'missing' / 'invalid-*')
 * — it names the failing rule, never any credential value.
 */
export const GET = withAuth(async (_req, user) => {
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      endpoint: true,
      userAgent: true,
      createdAt: true,
      updatedAt: true
    }
  });
  const status = getVapidStatus();
  return ok({
    configured: status.ok,
    configuredReason: status.ok ? 'ok' : status.reason,
    configuredDetail: status.ok ? null : status.detail,
    publicKey: status.ok ? getPublicVapidKey() : null,
    subscriptions: subscriptions.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString()
    }))
  });
});

/**
 * Create or update this user's push subscription (upsert per endpoint).
 * Ownership rule: an endpoint registered to ANOTHER user is never modified —
 * the request is rejected with 409.
 */
export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'push:subscribe', 30);
  const body = pushSubscriptionSchema.parse(await readJson(req));

  const existing = await db.pushSubscription.findUnique({
    where: { endpoint: body.endpoint }
  });
  if (existing && existing.userId !== user.id) {
    throw new ApiError('CONFLICT', 'This push subscription belongs to another account.', 409);
  }

  if (!existing) {
    const count = await db.pushSubscription.count({ where: { userId: user.id } });
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
      // Drop the oldest device — bounded storage, newest devices win.
      const oldest = await db.pushSubscription.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      });
      if (oldest) await db.pushSubscription.delete({ where: { id: oldest.id } });
    }
  }

  const row = await db.pushSubscription.upsert({
    where: { endpoint: body.endpoint },
    update: {
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: body.userAgent ?? null
    },
    create: {
      userId: user.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: body.userAgent ?? null
    }
  });

  return ok({ subscriptionId: row.id }, { status: existing ? 200 : 201 });
});

/**
 * Remove one of MY subscriptions. Scoped by endpoint AND userId — removing
 * someone else's subscription is impossible (404, nothing revealed).
 */
export const DELETE = withAuth(async (req, user) => {
  const body = pushUnsubscribeSchema.parse(await readJson(req));
  const result = await db.pushSubscription.deleteMany({
    where: { endpoint: body.endpoint, userId: user.id }
  });
  if (result.count === 0) {
    throw new ApiError('NOT_FOUND', 'Subscription not found.', 404);
  }
  return ok({ removed: result.count });
});
