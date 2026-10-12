import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { getSessionUser, hashPassword, verifyPassword, hashToken, SESSION_COOKIE } from '@/lib/auth';
import { withAuth, ok, fail, readJson, ApiError } from '@/lib/api';
import { disconnectSocketsForSessions } from '@/lib/realtime';
import { changePasswordSchema } from '@/lib/validation';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Change the password of the signed-in user.
 *
 * Session semantics (Phase 3, Part 3): the CURRENT session survives — the
 * device that just proved knowledge of the current password stays signed in.
 * Every OTHER session is revoked and its sockets are disconnected server-side.
 * Outstanding password-reset links are invalidated (stale after the change).
 * The response message describes exactly this behavior.
 */
export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'password:change', 10);
  const body = changePasswordSchema.parse(await readJson(req));

  const record = await db.user.findUnique({ where: { id: user.id } });
  if (!record) throw new ApiError('NOT_FOUND', 'User not found.', 404);

  const valid = await verifyPassword(body.currentPassword, record.passwordHash);
  if (!valid) return fail('INVALID_PASSWORD', 'Your current password is incorrect.', 400);

  const passwordHash = await hashPassword(body.newPassword);

  // Identify the current session so exactly the OTHER sessions are revoked.
  const currentToken = cookies().get(SESSION_COOKIE)?.value;
  const currentTokenHash = currentToken ? hashToken(currentToken) : null;
  const doomed = await db.session.findMany({
    where: {
      userId: user.id,
      revokedAt: null,
      ...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {})
    },
    select: { id: true }
  });

  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { passwordHash } }),
    db.session.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
        ...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {})
      },
      data: { revokedAt: new Date() }
    }),
    // Password-reset links issued before the change are stale.
    db.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() }
    })
  ]);

  // Only the revoked sessions' sockets — the current device stays connected.
  disconnectSocketsForSessions(doomed.map((s) => s.id));

  return ok({ changed: true, note: 'Other sessions have been signed out.' });
});
