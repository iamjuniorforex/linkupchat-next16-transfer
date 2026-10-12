import { withAuth, ok, ApiError } from '@/lib/api';
import { accessFor, cancelSubscription, listInvoices, scheduleDowngrade } from '@/lib/billing';
import { entitlementsFor } from '@/lib/entitlements';
import { isPlanCode } from '@/lib/plans';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  const access = await accessFor(user.id);
  const invoices = await listInvoices(user.id);
  return ok({
    ...access,
    entitlements: entitlementsFor(access.plan),
    invoices
  });
});

export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'billing:update', 20);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  try {
    if (action === 'cancel') return ok(await cancelSubscription(user.id));
    if (action === 'downgrade') {
      const plan = String(body.plan || '');
      if (!isPlanCode(plan) || plan === 'FREE') throw new ApiError('VALIDATION_ERROR', 'Choose a valid plan.', 400);
      return ok(await scheduleDowngrade(user.id, plan));
    }
    throw new ApiError('VALIDATION_ERROR', 'Unsupported billing action.', 400);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('BILLING_ERROR', err instanceof Error ? err.message : 'Billing update failed.', 400);
  }
});
