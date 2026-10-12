import { db } from '@/lib/db';
import { hashToken, SESSION_COOKIE } from '@/lib/auth';
import { withAuth, ok, readJson } from '@/lib/api';
import { disconnectSocketsForSessions } from '@/lib/realtime';
import { z } from 'zod';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

/** List active sessions for the current user (Section 16 — Security). */
export const GET = withAuth(async (_req, user) => {
  const currentToken = cookies().get(SESSION_COOKIE)?.value;
  const sessions = await db.session.findMany({
    where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: {
      id: true,
      userAgent: true,
      ip: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      tokenHash: true
    }
  });

  return ok({
    sessions: sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: currentToken ? s.tokenHash === hashToken(currentToken) : false
    }))
  });
});

/** Revoke one session (or all others). */
export const DELETE = withAuth(async (req, user) => {
  const body = z
    .object({ sessionId: z.string().optional(), allOthers: z.boolean().optional() })
    .parse(await readJson(req));

  if (body.allOthers) {
    const currentToken = cookies().get(SESSION_COOKIE)?.value;
    const currentTokenHash = currentToken ? hashToken(currentToken) : null;
    // Collect the doomed session ids FIRST so exactly their sockets are
    // disconnected — the current device's socket stays connected.
    const doomed = await db.session.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
        ...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {})
      },
      select: { id: true }
    });
    await db.session.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
        ...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {})
      },
      data: { revokedAt: new Date() }
    });
    disconnectSocketsForSessions(doomed.map((s) => s.id));
    return ok({ revoked: 'others' });
  }

  if (body.sessionId) {
    const { count } = await db.session.updateMany({
      where: { id: body.sessionId, userId: user.id },
      data: { revokedAt: new Date() }
    });
    // Only fan out when the session actually belonged to this user.
    if (count > 0) disconnectSocketsForSessions([body.sessionId]);
    return ok({ revoked: body.sessionId });
  }

  return ok({ revoked: null });
});
