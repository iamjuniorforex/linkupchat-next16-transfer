/**
 * Phase 4E — GET /api/calls/ice API tests.
 *
 * Proves: authentication required; authenticated users receive exactly the
 * ICE-server configuration and nothing else; no server secrets in the
 * response; no-store caching. Parsing variants live in tests/ice-config.test.ts.
 *
 * Run: npm run test:ice-api:e2e   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';
const ARTIFACTS = path.join(process.cwd(), 'test-results');
const LOG = path.join(ARTIFACTS, 'ice-api.e2e.log');
fs.mkdirSync(ARTIFACTS, { recursive: true });

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

const ALLOWED_KEYS = new Set([
  'ok',
  'data',
  'iceServers',
  'stunConfigured',
  'turnConfigured',
  'urls',
  'username',
  'credential'
]);

/** Recursively assert every object key is in the ICE-only allowlist. */
function assertOnlyIceKeys(node: unknown, trail = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertOnlyIceKeys(v, `${trail}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      assert.ok(ALLOWED_KEYS.has(k), `unexpected key ${trail}.${k} — response must contain ONLY ICE configuration`);
      assertOnlyIceKeys(v, `${trail}.${k}`);
    }
  }
}

async function main() {
  console.log('■ ice-api: GET /api/calls/ice');

  let cookie = '';

  await check('unauthenticated request is rejected (401)', async () => {
    const res = await fetch(`${SERVER_URL}/api/calls/ice`);
    assert.equal(res.status, 401);
    const body = await res.text();
    fs.appendFileSync(LOG, `unauth -> ${res.status} ${body}\n`);
    assert.ok(!body.includes('iceServers'), 'config must not leak to unauthenticated callers');
  });

  await check('garbage session cookie is rejected (401)', async () => {
    const res = await fetch(`${SERVER_URL}/api/calls/ice`, {
      headers: { cookie: 'linkup_session=not-a-real-token' }
    });
    assert.equal(res.status, 401);
  });

  await check('authenticated user receives a valid ICE configuration', async () => {
    const login = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'alex', password: 'linkup123' })
    });
    assert.ok(login.ok, `login failed: ${login.status}`);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.ok(cookie.includes('linkup_session='), 'session cookie captured');

    const res = await fetch(`${SERVER_URL}/api/calls/ice`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.text();
    fs.appendFileSync(LOG, `auth -> ${res.status} ${body.replace(/"credential":"[^"]*"/g, '"credential":"[redacted]"')}\n`);
    const parsed = JSON.parse(body) as {
      ok: boolean;
      data: {
        iceServers: { urls: string | string[]; username?: string; credential?: string }[];
        stunConfigured: boolean;
        turnConfigured: boolean;
      };
    };
    assert.equal(parsed.ok, true);
    const { iceServers, stunConfigured, turnConfigured } = parsed.data;
    assert.ok(Array.isArray(iceServers) && iceServers.length > 0, 'at least one ICE server');
    assert.equal(typeof stunConfigured, 'boolean');
    assert.equal(typeof turnConfigured, 'boolean');
    for (const s of iceServers) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      assert.ok(urls.length > 0);
      for (const u of urls) {
        assert.match(String(u), /^(stun|stuns|turn|turns):/i, `ICE URL must be a (stun|turn) URL: ${u}`);
      }
      if (turnConfigured) {
        const hasTurn = urls.some((u) => /^turns?:/i.test(String(u)));
        if (hasTurn) {
          assert.ok(typeof s.username === 'string' && s.username.length > 0, 'turn entry carries username');
          assert.ok(typeof s.credential === 'string' && s.credential.length > 0, 'turn entry carries credential');
        }
      } else {
        assert.equal(s.username, undefined, 'no turn username when TURN is not configured');
        assert.equal(s.credential, undefined, 'no turn credential when TURN is not configured');
      }
    }
  });

  await check('response contains ONLY ICE configuration (allowlisted keys, nothing else)', async () => {
    const res = await fetch(`${SERVER_URL}/api/calls/ice`, { headers: { cookie } });
    const parsed = JSON.parse(await res.text()) as unknown;
    assertOnlyIceKeys(parsed);
  });

  await check('response never contains unrelated server secrets or env keys', async () => {
    const res = await fetch(`${SERVER_URL}/api/calls/ice`, { headers: { cookie } });
    const body = await res.text();
    for (const banned of [
      'DATABASE_URL',
      'postgresql://',
      'postgres://',
      'SESSION_SECRET',
      'JWT_SECRET',
      'AWS_SECRET',
      'R2_',
      'STORAGE_',
      'password',
      'DATABASE',
      'process.env'
    ]) {
      assert.ok(!body.includes(banned), `response leaked secret material: ${banned}`);
    }
  });

  await check('response is never cached (Cache-Control: no-store)', async () => {
    const res = await fetch(`${SERVER_URL}/api/calls/ice`, { headers: { cookie } });
    assert.equal((res.headers.get('cache-control') ?? '').toLowerCase(), 'no-store');
  });

  console.log('════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
