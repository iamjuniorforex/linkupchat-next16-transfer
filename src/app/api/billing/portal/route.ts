import { withAuth, ok, ApiError } from '@/lib/api';
import { startPortal } from '@/lib/billing';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (_req, user) => {
  try {
    return ok(await startPortal(user.id));
  } catch (err) {
    throw new ApiError('BILLING_ERROR', err instanceof Error ? err.message : 'Portal unavailable.', 400);
  }
});
