import { withAuth, ok, ApiError } from '@/lib/api';
import { completeTestCheckout, startCheckout } from '@/lib/billing';
import { clientTriedToSetBillingStatus } from '@/lib/billing-events';
import { isPlanCode } from '@/lib/plans';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'billing:checkout', 10);
  const body = await req.json().catch(() => ({}));
  if (clientTriedToSetBillingStatus(body)) {
    throw new ApiError('FORBIDDEN', 'Subscription status cannot be set by the client.', 400);
  }
  try {
    if (body.action === 'complete') {
      return ok(await completeTestCheckout(user.id, String(body.sessionId || '')));
    }
    const plan = String(body.plan || '');
    if (!isPlanCode(plan) || plan === 'FREE') throw new ApiError('VALIDATION_ERROR', 'Choose a paid plan.', 400);
    return ok(await startCheckout(user.id, plan));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : 'Checkout failed.';
    const status = message === 'Billing is not configured.' ? 503 : 400;
    throw new ApiError(status === 503 ? 'BILLING_UNAVAILABLE' : 'BILLING_ERROR', message, status);
  }
});
