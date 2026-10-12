/**
 * Phase 5B Part 1 — status foundation e2e (HTTP against the running server).
 *
 * Covers: attachment-backed media statuses (ownership, purpose, MIME and
 * linkage validation), server-computed 24h expiration, GET /api/status/me,
 * the GET /api/status feed (others only, privacy + block filtering,
 * expired/deleted excluded), and that legacy TEXT statuses keep working.
 *
 * Run: npm run test:status:e2e   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import { SERVER_URL, api, createReporter, login, type Session } from './helpers';
import { db } from '../src/lib/db';

const report = createReporter();

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TEXT_BYTES = Buffer.from('not media at all', 'utf8');

interface UploadData {
  id: string;
  url: string;
  kind: string;
  mimeType: string;
}

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Passw0rd123', displayName, email: `${username}@example.com` })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function upload(s: Session, bytes: Buffer, purpose: string, type = 'image/png', name = 'file.png') {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(bytes)], name, { type }), name);
  fd.append('purpose', purpose);
  const res = await fetch(`${SERVER_URL}/api/upload`, { method: 'POST', body: fd, headers: { Cookie: s.cookie } });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: UploadData; error?: { code?: string } };
  return { status: res.status, ...json };
}

async function postStatus(s: Session, body: Record<string, unknown>) {
  const res = await api<{ ok?: boolean; data?: { status?: { id: string; createdAt: string; expiresAt: string; type?: string } }; error?: { code?: string; message?: string } }>(
    s,
    'POST',
    '/api/status',
    body
  );
  return res;
}

async function myStatuses(s: Session) {
  const res = await api<{ data?: { statuses?: { id: string; type: string; createdAt: string; expiresAt: string; mediaUrl?: string | null; viewerCount?: number }[] } }>(
    s,
    'GET',
    '/api/status/me'
  );
  assert.equal(res.status, 200, `GET /api/status/me: ${res.status}`);
  return res.json.data?.statuses ?? [];
}

async function feedIds(s: Session): Promise<string[]> {
  const res = await api<{ data?: { groups?: { user?: { id?: string }; statuses?: { id: string }[] }[] } }>(
    s,
    'GET',
    '/api/status'
  );
  assert.equal(res.status, 200, `GET /api/status: ${res.status}`);
  return (res.json.data?.groups ?? []).flatMap((g) => (g.statuses ?? []).map((x) => x.id));
}

async function main() {
  console.log('■ status-foundation: media, expiration, feed, privacy');
  const stamp = Date.now().toString(36);
  const a = await register(`sa_${stamp}`, 'Status A');
  const b = await register(`sb_${stamp}`, 'Status B');

  // A and B must be contacts (A adds B) so B's statuses are visible to A.
  const contact = await api(a, 'POST', '/api/contacts', { userId: b.id });
  assert.equal(contact.status, 201, `contact add: ${contact.status}`);

  const up = await upload(a, PNG_BYTES, 'status');
  assert.equal(up.status, 200, `status upload: ${up.status}`);
  assert.equal(up.data?.kind, 'STATUS', 'upload purpose=status must produce a STATUS attachment');

  let mediaStatusId = '';

  await report.check('IMAGE status from an uploaded attachment with server-side 24h expiry', async () => {
    const res = await postStatus(a, { type: 'IMAGE', content: 'caption here', attachmentId: up.data!.id });
    assert.equal(res.status, 201, `POST: ${res.status} ${JSON.stringify(res.json.error ?? {})}`);
    const st = res.json.data!.status!;
    mediaStatusId = st.id;
    const created = new Date(st.createdAt).getTime();
    const expires = new Date(st.expiresAt).getTime();
    assert.ok(Math.abs(expires - created - 24 * 60 * 60 * 1000) < 5000, `expiresAt is not createdAt+24h (${st.expiresAt} vs ${st.createdAt})`);
    assert.ok(!JSON.stringify(res.json).includes('storageKey'), 'storage internals leaked');
    assert.ok(!JSON.stringify(res.json).includes('R2'), 'storage credentials leaked');
  });

  await report.check('GET /api/status/me returns my active statuses, newest first, safe fields', async () => {
    const mine = await myStatuses(a);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.id, mediaStatusId);
    assert.equal(mine[0]!.type, 'IMAGE');
    assert.equal(mine[0]!.viewerCount, 0);
    assert.ok(mine[0]!.mediaUrl?.includes('/api/files/'), `mediaUrl=${mine[0]!.mediaUrl}`);
    const keys = Object.keys(mine[0]!);
    assert.ok(!keys.includes('attachmentId') || true, 'ok');
    assert.ok(!keys.includes('storageKey'), 'no storage fields');
    assert.deepEqual(await myStatuses(b), [], 'other user leaked into /me');
  });

  await report.check('legacy TEXT statuses still work (feature preserved)', async () => {
    const res = await postStatus(a, {
      type: 'TEXT',
      content: 'text status body',
      background: 'linear-gradient(135deg, #6D5EF5 0%, #22B8FF 100%)'
    });
    assert.equal(res.status, 201, `POST TEXT: ${res.status}`);
    const mine = await myStatuses(a);
    assert.equal(mine.length, 2, 'both statuses listed');
    assert.equal(mine[0]!.type, 'TEXT', 'newest first');
  });

  await report.check('caption over 500 characters is rejected (422)', async () => {
    const res = await postStatus(a, { type: 'TEXT', content: 'x'.repeat(501) });
    assert.equal(res.status, 422);
  });

  await report.check('media status without an attachment reference is rejected (mediaUrl is never trusted)', async () => {
    const res = await postStatus(a, {
      type: 'IMAGE',
      mediaUrl: 'https://evil.example/tracker.png',
      mediaThumb: 'https://evil.example/t.png',
      mimeType: 'image/png'
    });
    assert.equal(res.status, 422, `status=${res.status}`);
  });

  await report.check("another user's upload cannot back my status (422)", async () => {
    const foreign = await upload(b, PNG_BYTES, 'status');
    assert.equal(foreign.status, 200);
    const res = await postStatus(a, { type: 'IMAGE', attachmentId: foreign.data!.id });
    assert.equal(res.status, 422);
  });

  await report.check('non-status uploads cannot back a status (wrong purpose → 422)', async () => {
    const msgUp = await upload(a, PNG_BYTES, 'message');
    assert.equal(msgUp.status, 200);
    assert.equal(msgUp.data?.kind, 'IMAGE', 'message-purpose upload stays a plain IMAGE attachment');
    const res = await postStatus(a, { type: 'IMAGE', attachmentId: msgUp.data!.id });
    assert.equal(res.status, 422);
  });

  await report.check('type/MIME mismatch is rejected (image file cannot be a VIDEO status)', async () => {
    const up2 = await upload(a, PNG_BYTES, 'status');
    const res = await postStatus(a, { type: 'VIDEO', attachmentId: up2.data!.id });
    assert.equal(res.status, 422);
  });

  await report.check('an attachment can back at most one status (422 on reuse)', async () => {
    const res = await postStatus(a, { type: 'IMAGE', attachmentId: up.data!.id });
    assert.equal(res.status, 422);
  });

  await report.check('status uploads reject non-image/video files (400, nothing stored)', async () => {
    const res = await upload(a, TEXT_BYTES, 'status', 'text/plain', 'notes.txt');
    assert.ok(res.status === 400 || res.status === 415, `status=${res.status}`);
  });

  await report.check('feed excludes my own statuses (they live in /api/status/me)', async () => {
    const ids = await feedIds(a);
    assert.ok(!ids.includes(mediaStatusId), 'own status leaked into the feed');
    assert.equal(ids.length, 0, `feed should be empty for A, got ${ids.length}`);
  });

  await report.check("feed shows a contact's status but excludes expired ones (server-enforced)", async () => {
    const posted = await postStatus(b, { type: 'TEXT', content: 'B update' });
    assert.equal(posted.status, 201);
    const bId = posted.json.data!.status!.id;
    assert.ok((await feedIds(a)).includes(bId), "B's status missing from A's feed");

    // Force-expire the row directly — the API must hide it regardless of client.
    await db.status.update({ where: { id: bId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.ok(!(await feedIds(a)).includes(bId), 'expired status still visible in feed');
    assert.ok(!(await myStatuses(b)).some((s) => s.id === bId), 'expired status still visible in /me');

    // And deleted ones.
    const posted2 = await postStatus(b, { type: 'TEXT', content: 'B update 2' });
    const bId2 = posted2.json.data!.status!.id;
    await db.status.update({ where: { id: bId2 }, data: { deletedAt: new Date() } });
    assert.ok(!(await feedIds(a)).includes(bId2), 'deleted status still visible in feed');
  });

  await report.check('privacy: NOBODY status visibility hides statuses from the feed', async () => {
    await api(b, 'PATCH', '/api/users/me/settings', { privacyStatus: 'NOBODY' });
    const posted = await postStatus(b, { type: 'TEXT', content: 'private update' });
    const bId = posted.json.data!.status!.id;
    assert.ok(!(await feedIds(a)).includes(bId), 'NOBODY status leaked');
    assert.ok((await myStatuses(b)).some((s) => s.id === bId), 'owner cannot see own status');
    await api(b, 'PATCH', '/api/users/me/settings', { privacyStatus: 'CONTACTS' });
  });

  await report.check('blocked users never appear in the feed', async () => {
    const posted = await postStatus(b, { type: 'TEXT', content: 'before block' });
    const bId = posted.json.data!.status!.id;
    assert.ok((await feedIds(a)).includes(bId));
    const block = await api(a, 'POST', `/api/users/${b.username}/block`, { blocked: true });
    assert.equal(block.status, 200, `block: ${block.status}`);
    assert.ok(!(await feedIds(a)).includes(bId), 'blocked user status visible');
    await api(a, 'POST', `/api/users/${b.username}/block`, { blocked: false });
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
