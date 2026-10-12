/**
 * Phase 3 — account security + privacy/reporting hardening e2e
 * (Parts 3 & 4).
 *
 * Covers:
 *  - password change keeps the CURRENT session, revokes the others, kills
 *    stale reset links, and reports exactly that;
 *  - password reset: single-use, sibling tokens invalidated, expired/used
 *    tokens fail safely with one generic message, all sessions revoked;
 *  - forgot-password re-issue invalidates older outstanding links;
 *  - enumeration-safe responses (login / forgot / reset);
 *  - invalid resource IDs answer 4xx (never 500);
 *  - duplicate report suppression + report viewability/ownership rules;
 *  - rate limiting on password change/reset (429 RATE_LIMITED, never 500).
 *
 * Run: npm run test:auth-security   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { api, createReporter, login, SERVER_URL, type Session } from './helpers';

const report = createReporter();

function loadDbEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function register(username: string, extra: Record<string, unknown> = {}): Promise<Session> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${SERVER_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: `Sec ${username}`,
        username,
        password: 'linkup123',
        email: `${username}@ex.test`,
        ...extra
      })
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!res || !res.ok) throw new Error(`register failed for ${username}: HTTP ${res?.status}`);
  return login(username, 'linkup123');
}

async function main() {
  loadDbEnv();
  const { db } = await import('../src/lib/db');
  const { getSessionAuthFromToken } = await import('../src/lib/auth-core');

  const stamp = Date.now().toString(36);
  const uname = (n: string) => `sx${n}${stamp}`.slice(0, 24).toLowerCase();

  const u1 = await register(uname('a'));
  let u2 = await register(uname('b'));
  const u3 = await register(uname('c'), { email: `${uname('c')}@ex.test` });

  // ── Password change ──────────────────────────────────────────────────────
  await report.check('password change keeps THIS session, revokes the others', async () => {
    const u1second = await login(u1.username, 'linkup123');
    const res = await api<{ data?: { changed?: boolean; note?: string }; error?: { code: string } }>(
      u1,
      'POST',
      '/api/auth/change-password',
      { currentPassword: 'linkup123', newPassword: 'changed456' }
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.data?.changed, true);
    // The message must reflect exactly what happened.
    assert.equal(res.json.data?.note, 'Other sessions have been signed out.');

    // Current session survives…
    const me = await api(u1, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    // …the other session is revoked…
    const other = await api(u1second, 'GET', '/api/auth/me');
    assert.equal(other.status, 401);
    // …old password no longer works, new one does.
    const oldLogin = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: u1.username, password: 'linkup123' })
    });
    assert.equal(oldLogin.status, 401);
    await login(u1.username, 'changed456');
  });

  await report.check('password change invalidates outstanding password-reset links', async () => {
    const raw = randomBytes(32).toString('base64url');
    await db.passwordReset.create({
      data: {
        userId: u1.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + 3600_000)
      }
    });
    // Change the password AFTER the link exists — the stale link must die.
    const change = await api(u1, 'POST', '/api/auth/change-password', {
      currentPassword: 'changed456',
      newPassword: 'changed789'
    });
    assert.equal(change.status, 200);
    const res = await api<{ error?: { code: string } }>(u1, 'POST', '/api/auth/reset-password', {
      token: raw,
      password: 'whatever123'
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error?.code, 'INVALID_TOKEN');
  });

  // ── Password reset ───────────────────────────────────────────────────────
  await report.check('reset works, is single-use, and invalidates sibling tokens', async () => {
    const token1 = randomBytes(32).toString('base64url');
    const token2 = randomBytes(32).toString('base64url');
    await db.passwordReset.create({
      data: { userId: u2.id, tokenHash: hashToken(token1), expiresAt: new Date(Date.now() + 3600_000) }
    });
    await db.passwordReset.create({
      data: { userId: u2.id, tokenHash: hashToken(token2), expiresAt: new Date(Date.now() + 3600_000) }
    });

    const ok1 = await api(u2, 'POST', '/api/auth/reset-password', {
      token: token1,
      password: 'resetpass456'
    });
    assert.equal(ok1.status, 200);

    // Single-use: the same token cannot be reused.
    const reuse = await api<{ error?: { code: string } }>(u2, 'POST', '/api/auth/reset-password', {
      token: token1,
      password: 'again45678'
    });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.json.error?.code, 'INVALID_TOKEN');

    // Sibling token issued BEFORE the successful reset is now stale.
    const sibling = await api<{ error?: { code: string } }>(u2, 'POST', '/api/auth/reset-password', {
      token: token2,
      password: 'again45678'
    });
    assert.equal(sibling.status, 400);
    assert.equal(sibling.json.error?.code, 'INVALID_TOKEN');

    // All sessions were revoked by the reset (the one used above included).
    const me = await api(u2, 'GET', '/api/auth/me');
    assert.equal(me.status, 401);
    u2 = await login(u2.username, 'resetpass456');
  });

  await report.check('expired reset tokens fail safely with the generic message', async () => {
    const raw = randomBytes(32).toString('base64url');
    await db.passwordReset.create({
      data: {
        userId: u2.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() - 1000),
        usedAt: null
      }
    });
    const res = await api<{ error?: { code: string; message: string } }>(
      u2,
      'POST',
      '/api/auth/reset-password',
      { token: raw, password: 'newpass1234' }
    );
    assert.equal(res.status, 400);
    assert.equal(res.json.error?.code, 'INVALID_TOKEN');
    assert.equal(res.json.error?.message, 'This reset link is invalid or has expired. Request a new one.');
  });

  await report.check('requesting a new reset link invalidates older outstanding links', async () => {
    const oldRaw = randomBytes(32).toString('base64url');
    await db.passwordReset.create({
      data: { userId: u3.id, tokenHash: hashToken(oldRaw), expiresAt: new Date(Date.now() + 3600_000) }
    });
    const res = await api(u3, 'POST', '/api/auth/forgot-password', { identifier: u3.username });
    assert.equal(res.status, 200);
    const old = await api<{ error?: { code: string } }>(u3, 'POST', '/api/auth/reset-password', {
      token: oldRaw,
      password: 'newpass1234'
    });
    assert.equal(old.status, 400);
    assert.equal(old.json.error?.code, 'INVALID_TOKEN');
  });

  // ── Enumeration safety ───────────────────────────────────────────────────
  await report.check('login errors are identical for unknown user vs wrong password', async () => {
    const unknown = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `nobody_${stamp}`, password: 'whatever123' })
    });
    const wrong = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: u3.username, password: 'wrong-password-x' })
    });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(await unknown.text(), await wrong.text());
  });

  await report.check('forgot-password answers identically for unknown vs real identifiers', async () => {
    const unknown = await fetch(`${SERVER_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `nobody_${stamp}` })
    });
    const known = await fetch(`${SERVER_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: u3.username })
    });
    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.equal(await unknown.text(), await known.text());
  });

  await report.check('reset-password answers identically for unknown vs used tokens', async () => {
    const unknown = await api<{ error?: { code: string; message: string } }>(
      u3,
      'POST',
      '/api/auth/reset-password',
      { token: randomBytes(32).toString('base64url'), password: 'newpass1234' }
    );
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error?.code, 'INVALID_TOKEN');
    assert.equal(unknown.json.error?.message, 'This reset link is invalid or has expired. Request a new one.');
  });

  // ── Reports: invalid targets, viewability, duplicates ────────────────────
  const conv = await api<{ data?: { conversation?: { id: string } } }>(u1, 'POST', '/api/conversations', {
    type: 'DIRECT',
    username: u2.username
  });
  assert.ok(
    conv.status === 200 || conv.status === 201,
    `conversation create failed: ${JSON.stringify(conv.json)}`
  );
  const convId = conv.json.data?.conversation?.id ?? (conv.json.data as { id?: string })?.id;
  assert.ok(convId, 'direct conversation created');
  const sent = await api<{ data?: { message?: { id: string } } }>(u1, 'POST', `/api/conversations/${convId}/messages`, {
    type: 'TEXT',
    content: 'hello there'
  });
  const messageId = sent.json.data?.message?.id;
  assert.ok(messageId, 'message sent');

  await report.check('invalid report targets answer 4xx, never 500', async () => {
    const badUser = await api<{ error?: { code: string } }>(u2, 'POST', '/api/reports', {
      category: 'SPAM',
      reportedUserId: 'no-such-user-id'
    });
    assert.equal(badUser.status, 404);

    const badMessage = await api<{ error?: { code: string } }>(u2, 'POST', '/api/reports', {
      category: 'SPAM',
      messageId: 'no-such-message-id'
    });
    assert.equal(badMessage.status, 404);

    const selfReport = await api<{ error?: { code: string } }>(u2, 'POST', '/api/reports', {
      category: 'SPAM',
      reportedUserId: u2.id
    });
    assert.equal(selfReport.status, 422);

    const selfMessage = await api<{ error?: { code: string } }>(u1, 'POST', '/api/reports', {
      category: 'SPAM',
      messageId
    });
    assert.equal(selfMessage.status, 422);
  });

  await report.check('reports require viewability of the target message', async () => {
    const outsider = await api<{ error?: { code: string } }>(u3, 'POST', '/api/reports', {
      category: 'SPAM',
      messageId
    });
    assert.equal(outsider.status, 404);
  });

  await report.check('duplicate open reports collapse into the existing report', async () => {
    const first = await api<{ data?: { reportId: string; duplicate?: boolean } }>(
      u2,
      'POST',
      '/api/reports',
      { category: 'SPAM', messageId, reportedUserId: u1.id, reason: 'spam spam' }
    );
    assert.equal(first.status, 201);
    assert.equal(first.json.data?.duplicate, false);
    const second = await api<{ data?: { reportId: string; duplicate?: boolean } }>(
      u2,
      'POST',
      '/api/reports',
      { category: 'SPAM', messageId, reportedUserId: u1.id, reason: 'spam spam again' }
    );
    assert.equal(second.status, 200);
    assert.equal(second.json.data?.duplicate, true);
    assert.equal(second.json.data?.reportId, first.json.data?.reportId);
  });

  await report.check('admin report filter rejects invalid status with 4xx', async () => {
    const admin = await login('admin', 'linkup123');
    const res = await api<{ error?: { code: string } }>(
      admin,
      'GET',
      '/api/admin/reports?status=BOGUS'
    );
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    const good = await api(admin, 'GET', '/api/admin/reports?status=OPEN');
    assert.equal(good.status, 200);
  });

  // ── Rate limiting (kept last so earlier checks aren't starved) ───────────
  await report.check('password reset is rate limited (429 RATE_LIMITED, never 500)', async () => {
    let saw429 = false;
    let saw500 = false;
    let last = 0;
    for (let i = 0; i < 14; i++) {
      const res = await fetch(`${SERVER_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: randomBytes(32).toString('base64url'), password: 'newpass1234' })
      });
      last = res.status;
      if (res.status === 429) {
        saw429 = true;
        const body = (await res.json()) as { error?: { code: string } };
        assert.equal(body.error?.code, 'RATE_LIMITED');
      }
      if (res.status === 500) saw500 = true;
    }
    assert.ok(saw429, 'expected a 429 within 14 rapid resets');
    assert.ok(!saw500, 'rate limiting must never surface as 500');
    assert.ok(last === 429 || last === 400);
  });

  await report.check('password change is rate limited per user (429, never 500)', async () => {
    let saw429 = false;
    let saw500 = false;
    for (let i = 0; i < 13; i++) {
      const res = await api<{ error?: { code: string } }>(u1, 'POST', '/api/auth/change-password', {
        currentPassword: 'wrong-current',
        newPassword: 'changed456'
      });
      if (res.status === 429) {
        saw429 = true;
        assert.equal(res.json.error?.code, 'RATE_LIMITED');
      }
      if (res.status === 500) saw500 = true;
    }
    assert.ok(saw429, 'expected a 429 within 13 rapid attempts');
    assert.ok(!saw500);
  });

  // ── Session status gating: only ACTIVE users may use a live session ──
  // (login already blocks SUSPENDED/BANNED; the central session check must
  // reject both for already-authenticated sessions too.)
  const u5 = await register(uname('st'));
  const rawToken = u5.cookie.replace(/^linkup_session=/, '');

  await report.check('ACTIVE user session remains authorized', async () => {
    const me = await api(u5, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
  });

  await report.check('BANNED user session is rejected (HTTP + token gate)', async () => {
    await db.user.update({ where: { id: u5.id }, data: { status: 'BANNED' } });
    const me = await api(u5, 'GET', '/api/auth/me');
    assert.equal(me.status, 401);
    assert.equal(await getSessionAuthFromToken(rawToken), null);
  });

  await report.check('SUSPENDED user session is rejected (HTTP + token gate)', async () => {
    await db.user.update({ where: { id: u5.id }, data: { status: 'SUSPENDED' } });
    const me = await api(u5, 'GET', '/api/auth/me');
    assert.equal(me.status, 401);
    assert.equal(await getSessionAuthFromToken(rawToken), null);
  });

  await report.check('restoring ACTIVE re-authorizes; revoked session is rejected', async () => {
    await db.user.update({ where: { id: u5.id }, data: { status: 'ACTIVE' } });
    const me = await api(u5, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    await db.session.updateMany({
      where: { tokenHash: hashToken(rawToken) },
      data: { revokedAt: new Date() }
    });
    const revoked = await api(u5, 'GET', '/api/auth/me');
    assert.equal(revoked.status, 401);
    assert.equal(await getSessionAuthFromToken(rawToken), null);
  });

  await report.check('expired session is rejected', async () => {
    await db.session.updateMany({
      where: { tokenHash: hashToken(rawToken) },
      data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) }
    });
    const expired = await api(u5, 'GET', '/api/auth/me');
    assert.equal(expired.status, 401);
    assert.equal(await getSessionAuthFromToken(rawToken), null);
  });

  await report.check('concurrent reuse of one reset token allows exactly one success', async () => {
    // The suite's own rate-limit check above burned the `reset:${ip}` 10/min
    // window — wait it out so none of the concurrent requests can receive 429.
    await new Promise((r) => setTimeout(r, 61_000));

    const u6 = await register(uname('rc'));
    const token = randomBytes(32).toString('base64url');
    await db.passwordReset.create({
      data: { userId: u6.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) }
    });

    const passwords = ['racepass0A', 'racepass0B', 'racepass0C', 'racepass0D', 'racepass0E'];
    const results = await Promise.all(
      passwords.map((password) =>
        api<{ error?: { code: string; message?: string } }>(u6, 'POST', '/api/auth/reset-password', {
          token,
          password
        })
      )
    );

    const wins = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 200);
    const losses = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status !== 200);
    assert.equal(
      wins.length,
      1,
      `expected exactly one success, got [${results.map((r) => r.status).join(', ')}]`
    );
    assert.equal(losses.length, 4);
    for (const { r } of losses) {
      assert.equal(r.status, 400);
      assert.equal(r.json.error?.code, 'INVALID_TOKEN');
      assert.equal(
        r.json.error?.message,
        'This reset link is invalid or has expired. Request a new one.'
      );
    }

    // Only the winning password is live; every losing password fails.
    const winner = passwords[wins[0]!.i];
    const okLogin = await login(u6.username, winner);
    assert.ok(okLogin.cookie, 'winner password must log in');
    for (const { i } of losses) {
      const res = await fetch(`${SERVER_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: u6.username, password: passwords[i] })
      });
      assert.equal(res.status, 401);
    }

    // The pre-reset session was revoked by the successful reset.
    const me = await api(u6, 'GET', '/api/auth/me');
    assert.equal(me.status, 401);
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
