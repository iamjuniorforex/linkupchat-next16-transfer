/**
 * Remediation — email verification was incomplete (audit MEDIUM #4): the
 * registration flow created a VerificationToken but no endpoint consumed it
 * and `emailVerifiedAt` was never set.
 *
 * Drives the new POST /api/auth/verify-email endpoint end-to-end. The
 * verification CODE only exists inside the (undeliverable-in-CI) email, so
 * this suite seeds VerificationToken rows directly — with the same SHA-256
 * hashing the server uses — which also proves codes are stored hashed.
 *
 * Covers: valid code; expired code; invalid code; reuse (single-use);
 * cross-user isolation; unauthenticated rejection; emailVerifiedAt being set;
 * registration token creation; phone-only registration preserved; brute-force
 * rate limiting; resend (fresh usable code, old code retired, one outstanding
 * code, 15-min TTL); resend rate limiting; already-verified resend refusal.
 *
 * Run: npm run test:email-verify   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, createReporter, login, type Session } from './helpers';

const report = createReporter();
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';

/** Minimal .env loader so the Prisma client gets DATABASE_URL in test runs. */
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

async function registerUser(
  username: string,
  extra: Record<string, string> = {}
): Promise<{ session: Session; userId: string }> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Passw0rd123',
      displayName: 'Verify User',
      email: `${username}@example.com`,
      ...extra
    })
  });
  const json = (await res.json()) as { data?: { userId?: string } };
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return { session: await login(username, 'Passw0rd123'), userId: json.data!.userId! };
}

async function main() {
  console.log('■ email-verify: verification codes are consumed safely and set emailVerifiedAt');
  loadDbEnv();
  const [{ db }, { hashToken }] = await Promise.all([
    import('../src/lib/db'),
    import('../src/lib/auth-core')
  ]);
  const stamp = Date.now().toString(36);

  // ── registration creates a hashed, single-use-ready token ────────────────
  const u1 = await registerUser(`ev_a${stamp}`);
  await report.check('registration stores the code hashed (never plaintext)', async () => {
    const rows = await db.verificationToken.findMany({ where: { userId: u1.userId } });
    assert.equal(rows.length, 1, 'expected exactly one verification token');
    assert.equal(rows[0].channel, 'email');
    assert.equal(rows[0].usedAt, null);
    assert.ok(rows[0].expiresAt > new Date(), 'fresh token already expired');
    assert.notEqual(rows[0].codeHash, '000000');
    assert.match(rows[0].codeHash, /^[0-9a-f]{64}$/, 'codeHash is not a sha256 hex digest');
    assert.ok(!rows[0].codeHash.includes('@'), 'codeHash leaked the email');
  });

  await report.check('valid code verifies the email and sets emailVerifiedAt', async () => {
    const code = '123456';
    await db.verificationToken.updateMany({
      where: { userId: u1.userId, usedAt: null },
      data: { codeHash: hashToken(code) }
    });

    const before = await api<{ data?: { emailVerified?: boolean } }>(u1.session, 'GET', '/api/auth/me');
    assert.equal(before.json.data?.emailVerified, false);

    const res = await api(u1.session, 'POST', '/api/auth/verify-email', { code });
    assert.equal(res.status, 200, `verify failed: ${res.status}`);

    const after = await api<{ data?: { emailVerified?: boolean } }>(u1.session, 'GET', '/api/auth/me');
    assert.equal(after.json.data?.emailVerified, true, 'emailVerified not surfaced after verification');

    const row = await db.verificationToken.findFirst({
      where: { userId: u1.userId, codeHash: hashToken(code) }
    });
    assert.ok(row?.usedAt, 'token was not marked used');
  });

  await report.check('a used code cannot be reused (single-use)', async () => {
    const res = await api(u1.session, 'POST', '/api/auth/verify-email', { code: '123456' });
    assert.equal(res.status, 400);
  });

  await report.check('invalid code is rejected generically', async () => {
    const res = await api(u1.session, 'POST', '/api/auth/verify-email', { code: '999111' });
    assert.equal(res.status, 400);
    const json = res.json as { error?: { code?: string } };
    assert.equal(json.error?.code, 'INVALID_CODE');
  });

  await report.check('expired code is rejected', async () => {
    const expired = await registerUser(`ev_x${stamp}`);
    await db.verificationToken.updateMany({
      where: { userId: expired.userId, usedAt: null },
      data: { codeHash: hashToken('654321'), expiresAt: new Date(Date.now() - 60_000) }
    });
    const res = await api(expired.session, 'POST', '/api/auth/verify-email', { code: '654321' });
    assert.equal(res.status, 400);
    const row = await db.verificationToken.findFirst({
      where: { userId: expired.userId, codeHash: hashToken('654321') }
    });
    assert.equal(row?.usedAt, null, 'expired token must stay unconsumed');
  });

  await report.check("another user's code never verifies my account", async () => {
    const victim = await registerUser(`ev_v${stamp}`);
    await db.verificationToken.updateMany({
      where: { userId: victim.userId, usedAt: null },
      data: { codeHash: hashToken('555000') }
    });
    // u1 submits the victim's code — lookup is scoped to the caller's tokens.
    const res = await api(u1.session, 'POST', '/api/auth/verify-email', { code: '555000' });
    assert.equal(res.status, 400);
  });

  await report.check('unauthenticated callers get 401', async () => {
    const res = await fetch(`${SERVER_URL}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(res.status, 401);
  });

  await report.check('phone-only registration is preserved (no email token)', async () => {
    const res = await fetch(`${SERVER_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `ev_p${stamp}`,
        password: 'Passw0rd123',
        displayName: 'Phone Only',
        phone: `+233555${String(Date.now()).slice(-6)}`
      })
    });
    assert.ok(res.ok, `phone-only register failed: ${res.status}`);
    const json = (await res.json()) as { data?: { userId?: string } };
    const rows = await db.verificationToken.findMany({ where: { userId: json.data!.userId! } });
    assert.equal(rows.length, 0, 'phone-only signup should not create an email token');
  });

  await report.check('verification attempts are rate-limited (brute force)', async () => {
    const spammer = await registerUser(`ev_r${stamp}`);
    const codes = Array.from({ length: 12 }, (_, i) => `1000${String(i).padStart(2, '0')}`);
    const statuses: number[] = [];
    for (const code of codes) {
      const res = await api(spammer.session, 'POST', '/api/auth/verify-email', { code });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected 429 among ${statuses.join(',')}`);
  });

  await report.check('concurrent reuse of one verification code allows exactly one success', async () => {
    const racer = await registerUser(`ev_c${stamp}`);
    const code = '424242';
    await db.verificationToken.updateMany({
      where: { userId: racer.userId, usedAt: null },
      data: { codeHash: hashToken(code) }
    });

    // 5 simultaneous submissions of the same code (6 total ≤ the 10/min limit).
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => api(racer.session, 'POST', '/api/auth/verify-email', { code }))
    );
    const statuses = responses.map((r) => r.status);
    assert.equal(
      statuses.filter((s) => s === 200).length,
      1,
      `expected exactly one 200, got [${statuses.join(',')}]`
    );
    assert.equal(
      statuses.filter((s) => s === 400).length,
      4,
      `expected four 400s, got [${statuses.join(',')}]`
    );

    // Every losing response is the existing generic error — identical code and
    // identical message (no divergence leak).
    const losers = responses.filter((r) => r.status === 400);
    for (const r of losers) {
      const body = r.json as { error?: { code?: string; message?: string } };
      assert.equal(body.error?.code, 'INVALID_CODE');
    }
    const messages = new Set(
      losers.map((r) => (r.json as { error?: { message?: string } }).error?.message)
    );
    assert.equal(messages.size, 1, 'all losing responses must share the identical generic message');

    // The single claim persisted: email verified, token consumed.
    const verifiedRow = await db.user.findUnique({ where: { id: racer.userId } });
    assert.ok(verifiedRow?.emailVerifiedAt, 'emailVerifiedAt must be set after the winning claim');
    const tokenRow = await db.verificationToken.findFirst({
      where: { userId: racer.userId, codeHash: hashToken(code) }
    });
    assert.ok(tokenRow?.usedAt, 'token must be marked used by the winning claim');

    // Sequential reuse after the race is still rejected.
    const reuse = await api(racer.session, 'POST', '/api/auth/verify-email', { code });
    assert.equal(reuse.status, 400);

    // The existing authenticated session is untouched by verification.
    const me = await api<{ data?: { emailVerified?: boolean } }>(racer.session, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.data?.emailVerified, true);
  });

  await report.check('resend issues a fresh usable code and retires the previous one', async () => {
    const r = await registerUser(`ev_re${stamp}`);
    const before = await db.verificationToken.findFirst({ where: { userId: r.userId, usedAt: null } });
    assert.ok(before, 'registration should leave one outstanding token');
    // Seed a KNOWN old code (the emailed plaintext is unreachable in CI).
    await db.verificationToken.update({ where: { id: before.id }, data: { codeHash: hashToken('111111') } });

    const res = await api(r.session, 'POST', '/api/auth/verify-email/resend', {});
    assert.equal(res.status, 200, `resend failed: ${res.status}`);

    // Old token consumed + exactly one NEW outstanding token, hashed, 15-min TTL.
    const rows = await db.verificationToken.findMany({
      where: { userId: r.userId },
      orderBy: { createdAt: 'asc' }
    });
    assert.equal(rows.length, 2, 'resend should create exactly one new token');
    const old = rows[0];
    const fresh = rows[1];
    assert.ok(old.usedAt, 'the previous code must be consumed on resend');
    assert.equal(fresh.usedAt, null, 'the replacement code must be outstanding');
    assert.match(fresh.codeHash, /^[0-9a-f]{64}$/, 'replacement must be stored hashed');
    assert.notEqual(fresh.codeHash, hashToken('111111'), 'the replacement must be a different code');
    const ttlMs = fresh.expiresAt.getTime() - Date.now();
    assert.ok(ttlMs > 14 * 60_000 && ttlMs <= 15 * 60_000 + 5_000, `unexpected TTL: ${ttlMs}ms`);

    // The retired code no longer works …
    const oldTry = await api(r.session, 'POST', '/api/auth/verify-email', { code: '111111' });
    assert.equal(oldTry.status, 400, 'old code must stop working after a resend');

    // … and the replacement is a usable code.
    await db.verificationToken.update({ where: { id: fresh.id }, data: { codeHash: hashToken('222222') } });
    const okTry = await api(r.session, 'POST', '/api/auth/verify-email', { code: '222222' });
    assert.equal(okTry.status, 200, `replacement code failed: ${okTry.status}`);
    const me = await api<{ data?: { emailVerified?: boolean } }>(r.session, 'GET', '/api/auth/me');
    assert.equal(me.json.data?.emailVerified, true);
  });

  await report.check('resend is rate limited (no mail bombing)', async () => {
    const spam = await registerUser(`ev_rr${stamp}`);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await api(spam.session, 'POST', '/api/auth/verify-email/resend', {});
      statuses.push(res.status);
    }
    assert.equal(
      statuses.filter((s) => s === 200).length,
      5,
      `expected 5 successes, got [${statuses.join(',')}]`
    );
    assert.ok(statuses.includes(429), `expected 429 among ${statuses.join(',')}`);
  });

  await report.check('already-verified users cannot abuse resend', async () => {
    const done = await registerUser(`ev_av${stamp}`);
    await db.verificationToken.updateMany({
      where: { userId: done.userId, usedAt: null },
      data: { codeHash: hashToken('777000') }
    });
    const verify = await api(done.session, 'POST', '/api/auth/verify-email', { code: '777000' });
    assert.equal(verify.status, 200);

    const tokenCount = await db.verificationToken.count({ where: { userId: done.userId } });
    const res = await api(done.session, 'POST', '/api/auth/verify-email/resend', {});
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const json = res.json as { error?: { code?: string } };
    assert.equal(json.error?.code, 'ALREADY_VERIFIED');
    // No new code was minted (and therefore nothing new was mailed).
    assert.equal(await db.verificationToken.count({ where: { userId: done.userId } }), tokenCount);
  });

  await report.check('resend requires authentication', async () => {
    const res = await fetch(`${SERVER_URL}/api/auth/verify-email/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 401);
  });

  await report.check('phone-only accounts get a clear NO_EMAIL refusal', async () => {
    const username = `ev_ne${stamp}`;
    const reg = await fetch(`${SERVER_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'Passw0rd123',
        displayName: 'Phone Only',
        phone: `+233777${String(Date.now()).slice(-6)}`
      })
    });
    assert.ok(reg.ok, `phone-only register failed: ${reg.status}`);
    const session = await login(username, 'Passw0rd123');
    const res = await api(session, 'POST', '/api/auth/verify-email/resend', {});
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const json = res.json as { error?: { code?: string } };
    assert.equal(json.error?.code, 'NO_EMAIL');
  });

  await db.$disconnect().catch(() => {});
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
