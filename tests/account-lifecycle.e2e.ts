/**
 * Production hardening — Task 2: account data export + account deletion.
 *
 * Drives the two new endpoints end-to-end:
 *  - POST /api/account/export  — downloadable JSON archive, strictly the
 *    caller's data (no user id accepted), no password hashes / token hashes /
 *    secrets, no other users' private data.
 *  - POST /api/account/delete  — exact "DELETE MY ACCOUNT" confirmation
 *    PLUS the caller's current password (generic refusal on mismatch),
 *    no user id accepted, deletes ONLY the caller: sessions revoked, sockets
 *    dropped, exclusive media objects cleaned up, sent messages anonymized
 *    (senderId → NULL) for surviving participants, filed reports retained
 *    with reporterId SET NULL for moderation, shared media and other
 *    users' data untouched.
 *
 * Run: npm run test:account-lifecycle   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, createReporter, login, history, type Session } from './helpers';

const report = createReporter();
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';

/** Minimal bytes that pass the strict content sniffer as a PNG. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

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

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Passw0rd123',
      displayName,
      email: `${username}@example.com`
    })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function upload(s: Session, purpose: string): Promise<{ id: string; url: string }> {
  const form = new FormData();
  form.set('purpose', purpose);
  form.set('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'probe.png');
  const res = await fetch(`${SERVER_URL}/api/upload`, {
    method: 'POST',
    headers: { Cookie: s.cookie },
    body: form
  });
  const json = (await res.json()) as { data?: { id?: string; url?: string } };
  assert.equal(res.status, 200, `upload failed: ${res.status}`);
  assert.ok(json.data?.id && json.data?.url);
  return { id: json.data.id, url: json.data.url };
}

function localPathOf(url: string): string {
  const key = url.replace(/^\/api\/files\//, '');
  return path.resolve(process.env.UPLOAD_DIR ?? './uploads', key);
}

async function main() {
  console.log('■ account-lifecycle: export is only the caller data; deletion is total and safe');
  loadDbEnv();
  const [{ db }] = await Promise.all([import('../src/lib/db')]);
  const stamp = Date.now().toString(36);

  // ── export guards ─────────────────────────────────────────────────────────
  await report.check('export and delete require authentication', async () => {
    for (const p of ['/api/account/export', '/api/account/delete']) {
      const res = await fetch(`${SERVER_URL}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' })
      });
      assert.equal(res.status, 401, `${p} without a session must be 401, got ${res.status}`);
    }
  });

  // Shared fixtures — created once so the suite stays inside the per-IP
  // register rate limit while the checks below stay granular.
  const exportGuard = await register(`al_e${stamp}`, 'Export Guard');
  const peer = await register(`al_b${stamp}`, 'Shared Peer');
  const guardUser = await register(`al_c${stamp}`, 'Confirm First');

  await report.check('export refuses payloads that try to select another account', async () => {
    const a = exportGuard;
    const res = await api(a, 'POST', '/api/account/export', { userId: 'someone-else' });
    assert.equal(res.status, 422, `userId payload must be rejected, got ${res.status}`);
  });

  await report.check('export returns only the caller\u2019s data, downloadable, with no secrets', async () => {
    const a = await register(`al_a${stamp}`, 'Export A');
    const b = peer;

    const convRes = await api<{ data?: { conversation?: { id?: string } } }>(
      a,
      'POST',
      '/api/conversations',
      { type: 'DIRECT', username: b.username }
    );
    const convId = convRes.json.data?.conversation?.id;
    assert.ok(convId, 'DM not created');

    const mine = 'export-marker-message';
    const theirs = 'peer-private-message';
    await api(a, 'POST', `/api/conversations/${convId}/messages`, { type: 'TEXT', content: mine });
    await api(b, 'POST', `/api/conversations/${convId}/messages`, { type: 'TEXT', content: theirs });

    // Raw fetch so the download headers are observable.
    const res = await fetch(`${SERVER_URL}/api/account/export`, {
      method: 'POST',
      headers: a.headers,
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200, `export failed: ${res.status}`);
    const disposition = res.headers.get('content-disposition') ?? '';
    assert.ok(disposition.includes('attachment'), 'export must be a downloadable attachment');
    assert.ok(disposition.includes('linkupchat-export-'), 'export filename expected');

    const doc = (await res.json()) as Record<string, any>;
    assert.equal(doc.version, 1);
    assert.equal(doc.profile.username, a.username);
    const raw = JSON.stringify(doc);
    assert.ok(raw.includes(mine), 'own sent message must be in the export');
    // Peer content must not appear in the message archive (a notification
    // body may quote it — that notification is the caller's own row).
    assert.ok(
      !JSON.stringify(doc.messages).includes(theirs),
      'peer\u2019s messages must NOT be in the export message archive'
    );
    assert.ok(!raw.includes(`${b.username}@example.com`), 'peer email must NOT leak');
    for (const forbidden of ['passwordHash', 'codeHash', 'tokenHash', 'sessionToken']) {
      assert.ok(!raw.includes(forbidden), `export leaked a secret field: ${forbidden}`);
    }
  });

  // ── delete guards + rate limiting ─────────────────────────────────────────
  await report.check('delete requires the exact confirmation phrase', async () => {
    const u = guardUser;
    for (const phrase of ['delete my account', 'DELETE MY ACCOUNTS']) {
      const res = await api(u, 'POST', '/api/account/delete', {
        confirmation: phrase,
        currentPassword: 'Passw0rd123'
      });
      assert.equal(res.status, 400, `phrase "${phrase}" must be refused, got ${res.status}`);
      const json = res.json as { error?: { code?: string } };
      assert.equal(json.error?.code, 'INVALID_CONFIRMATION');
    }
    // The account is untouched by all of this.
    const me = await api(u, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
  });

  await report.check('delete requires the correct current password (generic refusal)', async () => {
    const u = guardUser;

    // Correct phrase + wrong password → generic refusal.
    const wrong = await api(u, 'POST', '/api/account/delete', {
      confirmation: 'DELETE MY ACCOUNT',
      currentPassword: 'NotMyPassword1'
    });
    assert.equal(wrong.status, 400, `wrong password must be refused, got ${wrong.status}`);
    const json = wrong.json as { error?: { code?: string; message?: string } };
    assert.equal(json.error?.code, 'INVALID_PASSWORD');
    assert.equal(json.error?.message, 'Your current password is incorrect.');

    // Correct phrase + missing password → rejected.
    const missing = await api(u, 'POST', '/api/account/delete', { confirmation: 'DELETE MY ACCOUNT' });
    assert.equal(missing.status, 422, `missing password must be rejected, got ${missing.status}`);

    // The account is untouched.
    const me = await api(u, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
  });

  await report.check('delete attempts are rate limited per user', async () => {
    const u = guardUser;
    // Earlier checks in this suite consumed 4 of the 5/min budget; these
    // attempts must cross the limit and start answering 429.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await api(u, 'POST', '/api/account/delete', {
        confirmation: 'nope',
        currentPassword: 'Passw0rd123'
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected 429 among ${statuses.join(',')}`);
    // The account is untouched by all of this.
    const me = await api(u, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
  });

  await report.check('delete refuses payloads that try to select another account', async () => {
    const victim = exportGuard;
    const attacker = await register(`al_x${stamp}`, 'Attacker');
    const res = await api(attacker, 'POST', '/api/account/delete', {
      confirmation: 'DELETE MY ACCOUNT',
      currentPassword: 'Passw0rd123',
      userId: victim.id
    });
    assert.equal(res.status, 422, `userId payload must be rejected, got ${res.status}`);
    const me = await api(victim, 'GET', '/api/auth/me');
    assert.equal(me.status, 200, 'victim must be untouched');
  });

  // ── deletion execution ────────────────────────────────────────────────────
  await report.check('deletion removes the account, revokes sessions, anonymizes messages and cleans only exclusive media', async () => {
    const a = await register(`al_d${stamp}`, 'Delete Me');
    const b = peer;

    const convRes = await api<{ data?: { conversation?: { id?: string } } }>(
      a,
      'POST',
      '/api/conversations',
      { type: 'DIRECT', username: b.username }
    );
    const convId = convRes.json.data?.conversation?.id;
    assert.ok(convId, 'DM not created');

    // Exclusive media: uploaded, never attached to a message or status.
    const exclusive = await upload(a, 'message');
    // Shared media: attached to a message the peer keeps.
    const shared = await upload(a, 'message');
    const sent = await api<{ data?: { message?: { id?: string } } }>(
      a,
      'POST',
      `/api/conversations/${convId}/messages`,
      { type: 'IMAGE', content: 'gone soon', attachmentIds: [shared.id] }
    );
    assert.ok([200, 201].includes(sent.status), `send failed: ${sent.status}`);
    await api(b, 'POST', `/api/conversations/${convId}/messages`, { type: 'TEXT', content: 'peer stays' });

    const exclusivePath = localPathOf(exclusive.url);
    const sharedPath = localPathOf(shared.url);
    assert.ok(fs.existsSync(exclusivePath), 'exclusive object missing before deletion');
    assert.ok(fs.existsSync(sharedPath), 'shared object missing before deletion');

    const res = await api<{ data?: { deleted?: boolean; mediaObjectsDeleted?: number } }>(
      a,
      'POST',
      '/api/account/delete',
      { confirmation: 'DELETE MY ACCOUNT', currentPassword: 'Passw0rd123' }
    );
    assert.equal(res.status, 200, `delete failed: ${res.status}`);
    assert.equal(res.json.data?.deleted, true);
    assert.ok((res.json.data?.mediaObjectsDeleted ?? 0) >= 1, 'exclusive media should be cleaned');

    // All sessions are dead: the old cookie is rejected and nobody can log in.
    const me = await api(a, 'GET', '/api/auth/me');
    assert.equal(me.status, 401, 'old session must be invalid after deletion');
    const relogin = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: a.username, password: 'Passw0rd123' })
    });
    assert.ok(!relogin.ok, 'deleted account must not be able to log in');

    // Exclusive media: object gone, row gone. Shared media: both survive.
    assert.equal(fs.existsSync(exclusivePath), false, 'exclusive storage object survived deletion');
    assert.ok(fs.existsSync(sharedPath), 'shared storage object must survive');
    const exclusiveRow = await db.attachment.findUnique({ where: { id: exclusive.id } });
    assert.equal(exclusiveRow, null, 'exclusive attachment row should be removed');
    const sharedRow = await db.attachment.findUnique({ where: { id: shared.id } });
    assert.ok(sharedRow, 'shared attachment row must survive');

    // The peer's history survives; the sender is anonymized.
    const msgs = await history(b, convId);
    const anonymized = msgs.find((m) => m.content === 'gone soon');
    assert.ok(anonymized, 'sent message must survive for the peer');
    assert.equal(anonymized.senderId, null, 'sender must be anonymized (senderId NULL)');
    const peerMsg = msgs.find((m) => m.content === 'peer stays');
    assert.ok(peerMsg && peerMsg.senderId === b.id, 'peer message must be untouched');

    // The peer's account is fully intact.
    const peerMe = await api(b, 'GET', '/api/auth/me');
    assert.equal(peerMe.status, 200);
  });

  await report.check('duplicate/concurrent deletion requests are handled safely', async () => {
    const a = await register(`al_r${stamp}`, 'Race Delete');
    const b = peer;

    const convRes = await api<{ data?: { conversation?: { id?: string } } }>(
      a,
      'POST',
      '/api/conversations',
      { type: 'DIRECT', username: b.username }
    );
    const convId = convRes.json.data?.conversation?.id;
    assert.ok(convId, 'DM not created');
    await api(a, 'POST', `/api/conversations/${convId}/messages`, { type: 'TEXT', content: 'race msg' });

    // 5 simultaneous deletions of the SAME account with the same session.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(a, 'POST', '/api/account/delete', {
          confirmation: 'DELETE MY ACCOUNT',
          currentPassword: 'Passw0rd123'
        })
      )
    );
    const statuses = responses.map((r) => r.status);
    // Safe outcomes only: an idempotent 200 or a 401 for a session that was
    // already torn down mid-race. Never a 5xx.
    for (const s of statuses) {
      assert.ok(s === 200 || s === 401, `unsafe status in race: [${statuses.join(',')}]`);
    }
    assert.ok(statuses.filter((s) => s === 200).length >= 1, 'at least one request must win');

    // Exactly one deletion effect: the account is gone, the peer and the
    // surviving history are intact (anonymized), and nothing double-deleted.
    const relogin = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: a.username, password: 'Passw0rd123' })
    });
    assert.ok(!relogin.ok, 'deleted account must stay deleted');
    const msgs = await history(b, convId);
    const survived = msgs.find((m) => m.content === 'race msg');
    assert.ok(survived, 'peer history must survive the race');
    assert.equal(survived.senderId, null, 'sender must be anonymized exactly once');
    const peerMe = await api(b, 'GET', '/api/auth/me');
    assert.equal(peerMe.status, 200, 'peer must be untouched by the race');
  });

  await report.check('filed reports survive deletion with reporter anonymized', async () => {
    const a = await register(`al_s${stamp}`, 'Reporter Survives');
    const b = peer;

    const convRes = await api<{ data?: { conversation?: { id?: string } } }>(
      a,
      'POST',
      '/api/conversations',
      { type: 'DIRECT', username: b.username }
    );
    const convId = convRes.json.data?.conversation?.id;
    assert.ok(convId, 'DM not created');
    const msgRes = await api<{ data?: { message?: { id?: string } } }>(
      b,
      'POST',
      `/api/conversations/${convId}/messages`,
      { type: 'TEXT', content: 'reported content' }
    );
    const messageId = msgRes.json.data?.message?.id;
    assert.ok(messageId, 'message not created');

    // A files a report through the real endpoint, then deletes their account.
    const reportRes = await api(a, 'POST', '/api/reports', {
      category: 'SPAM',
      messageId,
      reportedUserId: b.id
    });
    assert.equal(reportRes.status, 201, `report must be filed, got ${reportRes.status}`);
    const reportRow = await db.report.findFirst({ where: { messageId } });
    assert.ok(reportRow, 'report row must exist before deletion');

    const del = await api<{ data?: { deleted?: boolean } }>(a, 'POST', '/api/account/delete', {
      confirmation: 'DELETE MY ACCOUNT',
      currentPassword: 'Passw0rd123'
    });
    assert.equal(del.status, 200, `delete must succeed, got ${del.status}`);

    // Retention: the row SURVIVES with reporterId SET NULL (never cascaded).
    const retained = await db.report.findUnique({ where: { id: reportRow.id } });
    assert.ok(retained, 'filed report must be retained for moderation after deletion');
    assert.equal(retained.reporterId, null, 'reporterId must be anonymized to NULL');
    assert.equal(retained.reportedUserId, b.id, 'report target stays for moderation');
    assert.equal(retained.messageId, messageId, 'reported message reference stays');

    // No credentials or secrets leak into the retained report row.
    const serialized = JSON.stringify(retained);
    assert.ok(!serialized.includes('Passw0rd123'), 'no password material in the report');
    assert.ok(!serialized.includes('token'), 'no tokens in the report');
    assert.ok(!serialized.includes('password'), 'no password fields in the report');

    // The peer account is untouched.
    const me = await api(b, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
  });

  await db.$disconnect().catch(() => {});
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
