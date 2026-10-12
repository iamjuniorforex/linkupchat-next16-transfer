import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getSessionUser, type SessionUser } from './auth';

/**
 * Uniform API responses. Internal errors are logged server-side and
 * never leaked to clients (Section 27).
 */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(code: string, message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, error: { code, message, details } }, { status });
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function handleRouteError(err: unknown) {
  if (err instanceof ApiError) {
    return fail(err.code, err.message, err.status);
  }
  if (err instanceof ZodError) {
    return fail('VALIDATION_ERROR', 'Please check the highlighted fields.', 422, err.flatten().fieldErrors);
  }
  console.error('[api] unhandled error:', err);
  return fail('INTERNAL', 'Something went wrong. Please try again.', 500);
}

/** Wraps a route handler with auth + error handling. */
export function withAuth(
  handler: (req: Request, user: SessionUser, ctx?: unknown) => Promise<Response> | Response
) {
  return async (req: Request, ctx?: unknown) => {
    try {
      const user = await getSessionUser();
      if (!user) return fail('UNAUTHORIZED', 'Please log in to continue.', 401);
      return await handler(req, user, ctx);
    } catch (err) {
      return handleRouteError(err);
    }
  };
}

/** Wraps a route handler that may run unauthenticated. */
export function withError(handler: (req: Request, ctx?: unknown) => Promise<Response> | Response) {
  return async (req: Request, ctx?: unknown) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return handleRouteError(err);
    }
  };
}

export function requireAdmin(user: SessionUser) {
  if (user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this area.', 403);
  }
}

export function getClientIp(req: Request): string {
  const real = req.headers.get('x-real-ip');
  if (process.env.NODE_ENV === 'production') {
    // X-Real-IP is set by the platform (Railway). X-Forwarded-For is
    // client-controlled and must NEVER key rate limits in production.
    return real ?? 'unknown';
  }
  // Development only: X-Real-IP first, X-Forwarded-For as a local-proxy
  // fallback so local workflows keep working.
  if (real) return real;
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return 'local';
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError('BAD_REQUEST', 'Invalid request body.');
  }
}
