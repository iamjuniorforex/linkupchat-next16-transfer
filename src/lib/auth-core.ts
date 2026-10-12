/**
 * Auth core — pure Node functions shared by the Next.js app and the
 * realtime (Socket.IO) server. No next/headers imports here.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from './db';

export const SESSION_COOKIE = 'linkup_session';
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Tokens are stored hashed (SHA-256) so a DB leak never exposes live session tokens. */
export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function createSession(opts: {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}) {
  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await db.session.create({
    data: {
      userId: opts.userId,
      tokenHash,
      userAgent: opts.userAgent?.slice(0, 512) ?? null,
      ip: opts.ip ?? null,
      expiresAt
    }
  });

  return { session, token, expiresAt };
}

export type RealtimeUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'USER' | 'MODERATOR' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
};

/**
 * Full session context for the realtime server (outside the Next.js request
 * scope): the user plus the SESSION identity. The session id is bound to the
 * socket at connect time so session revocation can invalidate exactly the
 * right connection later (see lib/realtime.ts). Only the hashed token is
 * stored on the session record — raw tokens are never persisted.
 */
export async function getSessionAuthFromToken(
  token: string | undefined | null
): Promise<{ user: RealtimeUser; sessionId: string; sessionTokenHash: string } | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          role: true,
          status: true
        }
      }
    }
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.user.status !== 'ACTIVE') return null;
  return {
    user: session.user as RealtimeUser,
    sessionId: session.id,
    sessionTokenHash: session.tokenHash
  };
}

/** Used by the realtime server (outside the Next.js request scope). */
export async function getSessionUserFromToken(token: string | undefined | null) {
  return (await getSessionAuthFromToken(token))?.user ?? null;
}
