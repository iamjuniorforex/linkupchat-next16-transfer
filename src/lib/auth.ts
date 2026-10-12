import { cookies } from 'next/headers';
import { db } from './db';
import { SESSION_COOKIE, hashToken, getSessionUserFromToken } from './auth-core';

export * from './auth-core';

export function setSessionCookie(token: string, expiresAt: Date) {
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt
  });
}

export function clearSessionCookie() {
  cookies().set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  about: string;
  role: 'USER' | 'MODERATOR' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  emailVerifiedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

/** Resolves the authenticated user from the session cookie (or null). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          phone: true,
          avatarUrl: true,
          about: true,
          role: true,
          status: true,
          emailVerifiedAt: true,
          lastSeenAt: true,
          createdAt: true
        }
      }
    }
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.user.status !== 'ACTIVE') return null;

  db.session
    .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return session.user as SessionUser;
}

export { getSessionUserFromToken };
