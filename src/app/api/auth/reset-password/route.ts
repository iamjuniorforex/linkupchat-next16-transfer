import { db } from '@/lib/db';
import { hashPassword, hashToken } from '@/lib/auth';
import { handleRouteError, ok, fail, readJson, getClientIp, ApiError } from '@/lib/api';
import { disconnectUserSockets } from '@/lib/realtime';
import { resetPasswordSchema } from '@/lib/validation';
import { assertRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Complete a password reset.
 *
 * Token rules (Phase 3, Part 3):
 *  - single-use: the token is consumed by an ATOMIC conditional claim inside
 *    the transaction (usedAt + password change are one unit of work, and only
 *    one concurrent request can ever observe claim count 1);
 *  - expired/used/unknown tokens fail safely with the SAME generic error
 *    (no account or token-state enumeration);
 *  - a successful reset invalidates EVERY other outstanding reset token for
 *    the user;
 *  - all sessions are revoked and their sockets disconnected (account
 *    recovery — nobody keeps a pre-reset session).
 */
export async function POST(req: Request) {
  try {
    assertRateLimit({ key: `reset:${getClientIp(req)}`, limit: 10, windowMs: 60_000 });

    const body = resetPasswordSchema.parse(await readJson(req));

    const reset = await db.passwordReset.findUnique({
      where: { tokenHash: hashToken(body.token) }
    });

    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      return fail('INVALID_TOKEN', 'This reset link is invalid or has expired. Request a new one.', 400);
    }

    const passwordHash = await hashPassword(body.password);

    await db.$transaction(async (tx) => {
      // Atomic claim: consumes THIS token only if it is still unused and
      // unexpired. Under READ COMMITTED a concurrent request blocks on the
      // row lock and its predicate re-check yields count 0 — so exactly one
      // request can ever pass the gate below.
      const claimed = await tx.passwordReset.updateMany({
        where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() }
      });
      if (claimed.count !== 1) {
        throw new ApiError('INVALID_TOKEN', 'This reset link is invalid or has expired. Request a new one.', 400);
      }

      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      // Single-use + invalidate every other outstanding token in one move.
      await tx.passwordReset.updateMany({
        where: { userId: reset.userId, usedAt: null },
        data: { usedAt: new Date() }
      });
      // Revoke all existing sessions after a password change (Section 18)
      await tx.session.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    });

    // All sessions were revoked above — invalidate every live socket too.
    disconnectUserSockets(reset.userId);

    return ok({ reset: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
