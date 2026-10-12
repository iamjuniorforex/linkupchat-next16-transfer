import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { accessFor } from '@/lib/billing';
import { entitlementsFor } from '@/lib/entitlements';
import { requestVerification } from '@/lib/business-rules';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (_req, user) => {
  const access = await accessFor(user.id);
  if (!entitlementsFor(access.plan).includes('business.tools')) {
    throw new ApiError('FORBIDDEN', 'LINKUPCHAT Business is required.', 403);
  }
  const existing = await db.businessProfile.findUnique({ where: { userId: user.id } });
  if (!existing?.name) throw new ApiError('VALIDATION_ERROR', 'Save a business profile before requesting verification.', 400);
  const gate = requestVerification(existing.verificationStatus);
  if (!gate.ok) throw new ApiError('CONFLICT', gate.reason, 409);
  await db.businessProfile.update({
    where: { userId: user.id },
    data: { verificationStatus: 'PENDING', verificationNote: null, submittedAt: new Date() }
  });
  return ok({ verificationStatus: 'PENDING' });
});
