import { db } from '@/lib/db';
import { clearSessionCookie, hashToken, SESSION_COOKIE } from '@/lib/auth';
import { handleRouteError, ok } from '@/lib/api';
import { disconnectSocketsForSessions } from '@/lib/realtime';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const token = cookies().get(SESSION_COOKIE)?.value;
    if (token) {
      const tokenHash = hashToken(token);
      const session = await db.session.findUnique({ where: { tokenHash } }).catch(() => null);
      await db.session
        .updateMany({
          where: { tokenHash, revokedAt: null },
          data: { revokedAt: new Date() }
        })
        .catch(() => {});
      // Session revocation fan-out: kill this session's live sockets so a
      // logged-out device stops receiving realtime events immediately.
      if (session) disconnectSocketsForSessions([session.id]);
    }
    clearSessionCookie();
    return ok({ loggedOut: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
