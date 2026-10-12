import { db } from '@/lib/db';
import { createSession, setSessionCookie, verifyPassword, hashPassword } from '@/lib/auth';
import { getClientIp, handleRouteError, ok, fail, readJson } from '@/lib/api';
import { loginSchema } from '@/lib/validation';
import { assertRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Fixed dummy hash so a failed lookup performs the SAME bcrypt work as a
 * wrong password — response timing cannot reveal account existence
 * (enumeration-safe). Not a secret: it is a throwaway hash of a constant.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('linkup-timing-equalization-dummy');
  return dummyHashPromise;
}

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    assertRateLimit({ key: `login:${ip}`, limit: 15, windowMs: 60_000 });

    const body = loginSchema.parse(await readJson(req));
    const identifier = body.identifier.toLowerCase();

    const user = await db.user.findFirst({
      where: {
        OR: [
          { username: identifier },
          { email: identifier },
          { phone: body.identifier.replace(/\s/g, '') }
        ]
      }
    });

    if (!user || user.status === 'BANNED') {
      // Same bcrypt work as a wrong password — no timing oracle.
      await verifyPassword(body.password, await getDummyHash()).catch(() => {});
      await db.loginEvent.create({
        data: { userId: user?.id ?? '', ip, userAgent: req.headers.get('user-agent'), success: false }
      }).catch(() => {});
      return fail('INVALID_CREDENTIALS', 'Incorrect username or password.', 401);
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      await db.loginEvent.create({
        data: { userId: user.id, ip, userAgent: req.headers.get('user-agent'), success: false }
      });
      return fail('INVALID_CREDENTIALS', 'Incorrect username or password.', 401);
    }

    if (user.status === 'SUSPENDED') {
      return fail('ACCOUNT_SUSPENDED', 'This account is suspended. Contact support for help.', 403);
    }

    const { token, expiresAt } = await createSession({
      userId: user.id,
      userAgent: req.headers.get('user-agent'),
      ip
    });
    setSessionCookie(token, expiresAt);

    await Promise.all([
      db.loginEvent.create({
        data: { userId: user.id, ip, userAgent: req.headers.get('user-agent'), success: true }
      }),
      db.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
    ]);

    return ok({ userId: user.id, username: user.username, displayName: user.displayName });
  } catch (err) {
    return handleRouteError(err);
  }
}
