import { db } from '@/lib/db';
import { generateToken } from '@/lib/auth';
import { getClientIp, handleRouteError, ok, readJson } from '@/lib/api';
import { forgotPasswordSchema } from '@/lib/validation';
import { assertRateLimit } from '@/lib/rate-limit';
import { passwordResetEmail, sendMail } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    assertRateLimit({ key: `forgot:${getClientIp(req)}`, limit: 5, windowMs: 60_000 });

    const body = forgotPasswordSchema.parse(await readJson(req));
    const identifier = body.identifier.toLowerCase();

    const user = await db.user.findFirst({
      where: { OR: [{ username: identifier }, { email: identifier }] }
    });

    // Always respond with success — do not reveal whether an account exists.
    if (!user || !user.email) {
      return ok({ sent: true });
    }

    const { token, tokenHash } = generateToken();
    // Latest link wins: a new request invalidates any earlier outstanding
    // reset link (Phase 3, Part 3). Older links fail safely with the same
    // generic error as any invalid token.
    await db.$transaction([
      db.passwordReset.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() }
      }),
      db.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60_000)
        }
      })
    ]);

    const resetUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/reset-password?token=${token}`;
    await sendMail(passwordResetEmail(user.email, user.displayName, resetUrl));

    return ok({ sent: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
