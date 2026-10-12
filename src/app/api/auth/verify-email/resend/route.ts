/**
 * Resend an email verification code (complete the email-verification loop).
 *
 * Registration emails a 6-digit code, but previously nothing produced a NEW
 * code after the 15-minute TTL lapsed. This endpoint generates a replacement
 * with the exact registration security model — CSPRNG 6-digit code, stored
 * ONLY as a SHA-256 hash (VerificationToken.codeHash), 15-minute TTL — and
 * consumes every previous outstanding token for the caller first, so at most
 * one code is ever valid at a time and an old code stops working the moment a
 * resend succeeds.
 *
 * Authenticated only and scoped to the caller's own account: the endpoint can
 * never be used to enumerate accounts or mailboxes. Rate-limited because
 * resends send real email and a 6-digit code is brute-forceable in isolation.
 * Already-verified accounts are refused so resend cannot be abused as a mail
 * cannon. Responses reveal nothing beyond the caller's own state.
 */
import { randomInt } from 'crypto';
import { db } from '@/lib/db';
import { hashToken } from '@/lib/auth';
import { withAuth, ok, fail, readJson } from '@/lib/api';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { resendVerificationSchema } from '@/lib/validation';
import { sendMail, verificationEmail } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'verify-email-resend', 5);

  await resendVerificationSchema.parse(await readJson(req));

  if (!user.email) {
    return fail('NO_EMAIL', 'This account has no email address to verify.', 400);
  }
  if (user.emailVerifiedAt) {
    return fail('ALREADY_VERIFIED', 'Your email is already verified.', 409);
  }

  // Same generation + hashing model as registration (never store plaintext).
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await db.$transaction(async (tx) => {
    // Retire every outstanding code BEFORE issuing the replacement, so a
    // resend always invalidates earlier codes (rows are marked used for the
    // audit trail rather than deleted).
    await tx.verificationToken.updateMany({
      where: { userId: user.id, channel: 'email', usedAt: null },
      data: { usedAt: new Date() }
    });
    await tx.verificationToken.create({
      data: {
        userId: user.id,
        channel: 'email',
        codeHash: hashToken(code),
        expiresAt: new Date(Date.now() + 15 * 60_000)
      }
    });
  });

  await sendMail(verificationEmail(user.email, user.displayName, code));

  return ok({ sent: true });
});
