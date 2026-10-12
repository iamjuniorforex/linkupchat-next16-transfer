import { randomInt } from 'crypto';
import { db } from '@/lib/db';
import { createSession, hashPassword, hashToken, setSessionCookie } from '@/lib/auth';
import { getClientIp, handleRouteError, ok, fail, readJson } from '@/lib/api';
import { registerSchema } from '@/lib/validation';
import { assertRateLimit } from '@/lib/rate-limit';
import { sendMail, verificationEmail } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    assertRateLimit({ key: `register:${getClientIp(req)}`, limit: 10, windowMs: 60_000 });

    const body = registerSchema.parse(await readJson(req));

    const existing = await db.user.findFirst({
      where: {
        OR: [
          { username: body.username },
          ...(body.email ? [{ email: body.email }] : []),
          ...(body.phone ? [{ phone: body.phone }] : [])
        ]
      }
    });

    if (existing) {
      if (existing.username === body.username) {
        return fail('USERNAME_TAKEN', 'That username is already taken.', 409);
      }
      return fail('IDENTITY_TAKEN', 'An account with that email or phone already exists.', 409);
    }

    const passwordHash = await hashPassword(body.password);

    const user = await db.user.create({
      data: {
        displayName: body.displayName,
        username: body.username,
        email: body.email ?? null,
        phone: body.phone ?? null,
        passwordHash,
        settings: { create: {} }
      }
    });

    // Email verification code (Section 4) — CSPRNG, stored hashed, 15-min TTL.
    if (user.email) {
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      await db.verificationToken.create({
        data: {
          userId: user.id,
          channel: 'email',
          codeHash: hashToken(code),
          expiresAt: new Date(Date.now() + 15 * 60_000)
        }
      });
      await sendMail(verificationEmail(user.email, user.displayName, code));
    }

    const { token, expiresAt } = await createSession({
      userId: user.id,
      userAgent: req.headers.get('user-agent'),
      ip: getClientIp(req)
    });
    setSessionCookie(token, expiresAt);

    await db.loginEvent.create({
      data: { userId: user.id, ip: getClientIp(req), userAgent: req.headers.get('user-agent'), success: true }
    });

    return ok({ userId: user.id, username: user.username }, { status: 201 });
  } catch (err) {
    return handleRouteError(err);
  }
}
