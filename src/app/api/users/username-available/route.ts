import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, ApiError } from '@/lib/api';
import { isReservedUsername, isValidUsernameShape, usernameChangeAllowed } from '@/lib/profile-privacy';

export const dynamic = 'force-dynamic';

/** Check whether the signed-in user can take a username. Does not reveal other accounts. */
export const GET = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'username:check', 30);
  const username = new URL(req.url).searchParams.get('username')?.trim().toLowerCase() ?? '';
  if (!username) throw new ApiError('VALIDATION_ERROR', 'Enter a username.', 422);
  if (!isValidUsernameShape(username)) {
    return ok({ available: false, reason: 'invalid' });
  }
  if (isReservedUsername(username)) {
    return ok({ available: false, reason: 'reserved' });
  }
  const me = await db.user.findUnique({
    where: { id: user.id },
    select: { username: true, usernameChangedAt: true }
  });
  const change = usernameChangeAllowed(me?.username ?? user.username, username, me?.usernameChangedAt);
  if (!change.ok) return ok({ available: false, reason: 'cooldown' });
  if (username === (me?.username ?? user.username)) return ok({ available: true, reason: 'current' });
  const taken = await db.user.findUnique({ where: { username }, select: { id: true } });
  return ok({ available: !taken, reason: taken ? 'taken' : 'available' });
});
