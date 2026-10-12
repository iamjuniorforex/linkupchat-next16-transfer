/**
 * Remediation M-1/M-2 — rate limiting (HTTP against the running server).
 *
 * M-1: rate-limit rejections must surface as 429 RATE_LIMITED (they used to
 * escape as unhandled 500s). M-2: mutating endpoints are limited per user.
 *
 * NOTE: run LAST in the battery — the register burst fills the IP window.
 *
 * Run: npm run test:rate-limit   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import { api, createReporter, login, SERVER_URL, type Session } from './helpers';

const report = createReporter();

async function registerRaw(username: string) {
  return fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Passw0rd123',
      displayName: 'Rate Limit',
      email: `${username}@example.com`
    })
  });
}

async function register(username: string): Promise<Session> {
  const res = await registerRaw(username);
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function main() {
  console.log('■ rate-limit: 429s (never 500s) on abuse');
  const stamp = Date.now().toString(36);
  const a = await register(`rl_${stamp}`);

  await report.check('search is rate limited per user (429 after the burst)', async () => {
    let last = 0;
    let saw429 = false;
    for (let i = 0; i < 80; i++) {
      const res = await api(a, 'GET', '/api/users/search?q=a');
      last = res.status;
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.equal(last, 429, `expected 429, last status ${last}`);
    assert.ok(saw429);
  });

  await report.check('message sending is rate limited per user (429)', async () => {
    const conv = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
      type: 'DIRECT',
      username: a.username
    });
    // Self-DM may be rejected; fall back to a fresh peer.
    let conversationId = conv.json.data?.conversation?.id;
    if (!conversationId) {
      const b = await register(`rlb_${stamp}`);
      const c2 = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
        type: 'DIRECT',
        username: b.username
      });
      conversationId = c2.json.data?.conversation?.id;
    }
    assert.ok(conversationId, 'need a conversation');
    let last = 0;
    let saw429 = false;
    for (let i = 0; i < 230; i++) {
      const res = await api(a, 'POST', `/api/conversations/${conversationId}/messages`, {
        type: 'TEXT',
        content: `burst ${i}`
      });
      last = res.status;
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.equal(last, 429, `expected 429, last status ${last}`);
    assert.ok(saw429);
  });

  await report.check('register is rate limited per IP and answers 429 (not 500)', async () => {
    let saw429 = false;
    let saw500 = false;
    for (let i = 0; i < 30; i++) {
      const res = await registerRaw(`rlr${i}${stamp.slice(0, 3)}`);
      if (res.status === 429) {
        saw429 = true;
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        assert.equal(body.error?.code, 'RATE_LIMITED', '429 must carry the RATE_LIMITED code');
        break;
      }
      if (res.status === 500) saw500 = true;
    }
    assert.ok(saw429, 'expected a 429 within 30 rapid registers');
    assert.ok(!saw500, 'rate limiting must never surface as 500');
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
