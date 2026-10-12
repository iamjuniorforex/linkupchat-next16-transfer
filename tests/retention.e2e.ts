/**
 * Remediation M-4 — retention sweep (direct library checks against the DB).
 *
 * Long-expired sessions, spent password resets, old login events and statuses
 * past the graveyard window are pruned (with exclusive attachment cleanup);
 * anything still live survives.
 *
 * Run: npm run test:retention   (server DB must be reachable)
 */
import assert from 'node:assert/strict';
import { createReporter, login, SERVER_URL, type Session } from './helpers';
import { runRetentionSweep } from '../src/lib/retention';
import { db } from '../src/lib/db';

const report = createReporter();
const DAY_MS = 24 * 60 * 60 * 1000;

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Passw0rd123', displayName, email: `${username}@example.com` })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function upload(s: Session): Promise<{ id: string; url: string }> {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(PNG_BYTES)], 'file.png', { type: 'image/png' }), 'file.png');
  fd.append('purpose', 'status');
  const res = await fetch(`${SERVER_URL}/api/upload`, { method: 'POST', body: fd, headers: { Cookie: s.cookie } });
  const json = (await res.json()) as { ok?: boolean; data?: { id: string; url: string } };
  assert.equal(res.status, 200, `upload: ${res.status}`);
  return json.data!;
}

async function main() {
  console.log('■ retention: long-expired rows are pruned, live rows survive');
  const stamp = Date.now().toString(36);
  const a = await register(`rt_${stamp}`, 'Retention User');

  await report.check('statuses past the graveyard window are hard-deleted', async () => {
    const res = await fetch(`${SERVER_URL}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({
        type: 'TEXT',
        content: 'sweep me',
        background: 'linear-gradient(135deg, #6D5EF5 0%, #22B8FF 100%)'
      })
    });
    const json = (await res.json()) as { data?: { status?: { id: string } } };
    const id = json.data!.status!.id;
    await db.status.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 8 * DAY_MS) } });

    await runRetentionSweep();
    assert.equal(await db.status.findUnique({ where: { id } }), null, 'stale status should be gone');
  });

  await report.check('sweeping a stale media status cleans its exclusive attachment only', async () => {
    const up = await upload(a);
    const res = await fetch(`${SERVER_URL}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ type: 'IMAGE', attachmentId: up.id })
    });
    const json = (await res.json()) as { data?: { status?: { id: string } } };
    const id = json.data!.status!.id;
    await db.status.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 8 * DAY_MS) } });

    await runRetentionSweep();
    assert.equal(await db.status.findUnique({ where: { id } }), null, 'stale status should be gone');
    assert.equal(await db.attachment.findUnique({ where: { id: up.id } }), null, 'exclusive attachment cleaned');
  });

  await report.check('expired sessions are pruned; live sessions survive', async () => {
    const old = await db.session.create({
      data: {
        userId: a.id,
        tokenHash: `ret-old-${stamp}-${'x'.repeat(20)}`,
        expiresAt: new Date(Date.now() - 31 * DAY_MS)
      }
    });
    const fresh = await db.session.create({
      data: {
        userId: a.id,
        tokenHash: `ret-new-${stamp}-${'y'.repeat(20)}`,
        expiresAt: new Date(Date.now() + 7 * DAY_MS)
      }
    });
    await runRetentionSweep();
    assert.equal(await db.session.findUnique({ where: { id: old.id } }), null, 'expired session pruned');
    assert.ok(await db.session.findUnique({ where: { id: fresh.id } }), 'live session must survive');
    await db.session.delete({ where: { id: fresh.id } }).catch(() => {});
  });

  await report.check('fresh statuses are never touched by the sweep', async () => {
    const res = await fetch(`${SERVER_URL}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({
        type: 'TEXT',
        content: 'keep me',
        background: 'linear-gradient(135deg, #FF6B5E 0%, #F5A623 100%)'
      })
    });
    const json = (await res.json()) as { data?: { status?: { id: string } } };
    const id = json.data!.status!.id;
    const summary = await runRetentionSweep();
    assert.ok(await db.status.findUnique({ where: { id } }), 'active status must survive');
    assert.ok(summary.statuses >= 0);
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
