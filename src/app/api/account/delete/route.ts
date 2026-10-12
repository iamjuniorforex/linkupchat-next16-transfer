/**
 * Account deletion (production hardening, Task 2) — destructive and permanent.
 *
 * Guards:
 *  - authenticated only, and the ONLY deletable account is the caller's — the
 *    payload cannot name a user id (unknown fields are rejected outright);
 *  - requires the exact typed confirmation "DELETE MY ACCOUNT" AND the
 *    caller's current password, so a hijacked session alone can never destroy
 *    the account and accidental deletion is difficult;
 *  - wrong password is refused with the same generic INVALID_PASSWORD error
 *    change-password uses (reveals nothing about accounts or credentials);
 *  - rate-limited per user.
 *
 * Execution is the tested plan from src/lib/account-deletion.ts: exclusive
 * media objects cleaned up first, every live socket disconnected, then the
 * user row — after which the schema's verified cascade / SET NULL rules apply
 * (all sessions gone, sent messages survive for other participants anonymized,
 * shared media and group data untouched).
 */
import { db } from '@/lib/db';
import { withAuth, ok, fail, readJson } from '@/lib/api';
import { clearSessionCookie, verifyPassword } from '@/lib/auth';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { deleteAccountSchema } from '@/lib/validation';
import { executeAccountDeletion } from '@/lib/account-deletion';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'account-delete', 5);

  const body = deleteAccountSchema.parse(await readJson(req));
  if (body.confirmation !== 'DELETE MY ACCOUNT') {
    return fail('INVALID_CONFIRMATION', 'Type DELETE MY ACCOUNT to confirm.', 400);
  }

  // Password re-check (same generic failure as change-password). The
  // submitted password is verified and discarded — never stored or logged.
  const record = await db.user.findUnique({ where: { id: user.id } });
  if (!record) {
    // Duplicate/racing deletion: the account is already gone.
    return ok({ deleted: true });
  }
  const valid = await verifyPassword(body.currentPassword, record.passwordHash);
  if (!valid) {
    return fail('INVALID_PASSWORD', 'Your current password is incorrect.', 400);
  }

  const summary = await executeAccountDeletion(user.id);
  clearSessionCookie();

  return ok({ deleted: true, ...summary });
});
