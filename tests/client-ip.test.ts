/**
 * Security audit issue #4 — client-IP trust model used by rate limiting.
 *
 * Pure unit tests (no server): getClientIp must key rate limits on the
 * platform-provided X-Real-IP in production and must NEVER trust the
 * client-controlled X-Forwarded-For there (a spoofed header would let an
 * attacker rotate rate-limit buckets at will). X-Forwarded-For remains a
 * development-only fallback so local proxy setups keep working.
 *
 * Run: npm run test:client-ip
 */
import assert from 'node:assert/strict';
import { getClientIp } from '../src/lib/api';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
    });
}

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/auth/login', { headers });
}

/** Run fn with NODE_ENV forced, restoring the previous value exactly. */
function asNodeEnv<T>(nodeEnv: string, fn: () => T): T {
  // Next.js types NODE_ENV as read-only; use a mutable alias for the swap.
  const env = process.env as Record<string, string | undefined>;
  const prev = env.NODE_ENV;
  env.NODE_ENV = nodeEnv;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = prev;
  }
}

async function main() {
  console.log('■ client-ip: rate-limit key trust model');

  await check('production: X-Real-IP wins over a spoofed X-Forwarded-For', () => {
    asNodeEnv('production', () => {
      const ip = getClientIp(
        reqWith({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6, 7.7.7.7' })
      );
      assert.equal(ip, '203.0.113.9', 'X-Real-IP must win');
    });
  });

  await check('production: X-Forwarded-For alone is ignored (stable fallback)', () => {
    asNodeEnv('production', () => {
      const ip = getClientIp(reqWith({ 'x-forwarded-for': '6.6.6.6' }));
      assert.equal(ip, 'unknown', 'forwarded value must never key rate limits in production');
    });
  });

  await check('production: normal request with X-Real-IP returns it unchanged', () => {
    asNodeEnv('production', () => {
      const ip = getClientIp(reqWith({ 'x-real-ip': '198.51.100.23' }));
      assert.equal(ip, '198.51.100.23');
    });
  });

  await check('development: X-Forwarded-For fallback keeps local behavior usable', () => {
    asNodeEnv('development', () => {
      const ip = getClientIp(reqWith({ 'x-forwarded-for': '10.0.0.5, 1.2.3.4' }));
      assert.equal(ip, '10.0.0.5', 'first forwarded value is the dev fallback');
    });
  });

  await check('development: X-Real-IP preferred; no headers falls back to local', () => {
    asNodeEnv('development', () => {
      assert.equal(
        getClientIp(reqWith({ 'x-real-ip': '192.0.2.7', 'x-forwarded-for': '6.6.6.6' })),
        '192.0.2.7'
      );
      assert.equal(getClientIp(reqWith({})), 'local');
    });
  });

  console.log(`\n════════════════════════════════════`);
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
