/**
 * In-memory sliding-window rate limiter.
 * Suitable for a single instance; in a horizontally-scaled deployment this
 * should be backed by Redis (documented in the README).
 */

import { ApiError } from '@/lib/api';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

const SWEEP_INTERVAL = 60_000;
let lastSweep = Date.now();

function sweep() {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

export function rateLimit(opts: {
  key: string;
  limit: number;
  windowMs: number;
}): { ok: boolean; remaining: number; retryAfterSec: number } {
  sweep();
  const now = Date.now();
  const bucket = buckets.get(opts.key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(opts.key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, remaining: opts.limit - 1, retryAfterSec: 0 };
  }

  bucket.count += 1;
  const ok = bucket.count <= opts.limit;
  return {
    ok,
    remaining: Math.max(0, opts.limit - bucket.count),
    retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000)
  };
}

export function assertRateLimit(opts: {
  key: string;
  limit: number;
  windowMs: number;
}) {
  const result = rateLimit(opts);
  if (!result.ok) {
    // ApiError so the shared error mapper returns a real 429 (not a 500).
    throw new ApiError('RATE_LIMITED', `Too many requests. Try again in ${result.retryAfterSec}s.`, 429);
  }
  return result;
}

/**
 * Per-user write-rate limit (M-2): guards abuse/spam on mutating endpoints.
 * Keyed by user so unrelated users and automated test suites are isolated.
 */
export function enforceUserRateLimit(
  userId: string,
  action: string,
  limit: number,
  windowMs = 60_000
) {
  assertRateLimit({ key: `u:${userId}:${action}`, limit, windowMs });
}

/**
 * Per-IP limit for endpoints where no user id is available yet.
 */
export function enforceIpRateLimit(
  ip: string,
  action: string,
  limit: number,
  windowMs = 60_000
) {
  assertRateLimit({ key: `ip:${ip}:${action}`, limit, windowMs });
}
