/**
 * Email verification (audit remediation: "verification token is created at
 * registration but never consumed").
 *
 * The 6-digit code emailed at registration is stored ONLY as a SHA-256 hash
 * (VerificationToken.codeHash). This endpoint consumes it: the code is
 * hashed and matched server-side, marked single-use (`usedAt`), and a valid
 * match sets `emailVerifiedAt` in the same transaction.
 *
 * Errors are generic (INVALID_CODE) — the endpoint is authenticated and only
 * ever looks at the caller's own tokens, so it cannot be used to enumerate
 * accounts or codes. Rate-limited because a 6-digit code is brute-forceable
 * in isolation.
 */
import { db } from '@/lib/db';
import { hashToken } from '@/lib/auth';
import { ApiError, withAuth, ok, fail, readJson } from '@/lib/api';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { verifyEmailSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'verify-email', 10);

  const body = verifyEmailSchema.parse(await readJson(req));

  const token = await db.verificationToken.findFirst({
    where: {
      userId: user.id,
      channel: 'email',
      codeHash: hashToken(body.code),
      usedAt: null,
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: 'desc' }
  });

  if (!token) {
    return fail('INVALID_CODE', 'That code is invalid or has expired. Request a new one.', 400);
  }

  await db.$transaction(async (tx) => {
    // Atomic claim: consumes THIS token only if it is still unused and
    // unexpired. Under READ COMMITTED a concurrent request blocks on the
    // row lock and its predicate re-check yields count 0 — so exactly one
    // request can ever pass the gate below.
    const claimed = await tx.verificationToken.updateMany({
      where: { id: token.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() }
    });
    if (claimed.count !== 1) {
      throw new ApiError('INVALID_CODE', 'That code is invalid or has expired. Request a new one.', 400);
    }

    await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  });

  return ok({ verified: true });
});
