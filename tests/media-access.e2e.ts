/**
 * Remediation H-1 — media access scoping (HTTP against the running server).
 *
 * Media is served only through the authenticated /api/files proxy, and only
 * to users related to the attachment: uploader, conversation members (message
 * media), the status audience (status media), or any session (avatars).
 *
 * Run: npm run test:media-access   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import { api, createReporter, login, SERVER_URL, type Session } from './helpers';
import { mediaHref } from '../src/lib/storage';

const report = createReporter();

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

async function upload(s: Session, purpose: string): Promise<{ id: string; url: string }> {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(PNG_BYTES)], 'file.png', { type: 'image/png' }), 'file.png');
  fd.append('purpose', purpose);
  const res = await fetch(`${SERVER_URL}/api/upload`, { method: 'POST', body: fd, headers: { Cookie: s.cookie } });
  const json = (await res.json()) as { ok?: boolean; data?: { id: string; url: string } };
  assert.equal(res.status, 200, `upload: ${res.status}`);
  return json.data!;
}

function fileKeyOf(url: string): string {
  const m = /\/api\/files\/(.+)$/.exec(url);
  assert.ok(m, `expected a proxy media URL, got ${url}`);
  return m![1];
}

async function getFile(s: Session | null, key: string, range?: string): Promise<Response> {
  return fetch(`${SERVER_URL}/api/files/${key}`, {
    headers: {
      ...(s ? { Cookie: s.cookie } : {}),
      ...(range ? { Range: range } : {})
    }
  });
}

async function main() {
  console.log('■ media-access: authenticated, attachment-scoped file serving');
  const stamp = Date.now().toString(36);
  const a = await register(`ma_${stamp}`, 'Media Access A');
  const b = await register(`mb_${stamp}`, 'Media Access B');
  const d = await register(`md_${stamp}`, 'Media Access D');

  // A ↔ B direct conversation with a message attachment. Status visibility is
  // viewer-contact-based ("the author is in my contacts"), so both directions.
  await api(a, 'POST', '/api/contacts', { userId: b.id });
  await api(b, 'POST', '/api/contacts', { userId: a.id });
  const conv = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
    type: 'DIRECT',
    username: b.username
  });
  assert.equal(conv.status, 201, `DIRECT create: ${conv.status}`);
  const conversationId = conv.json.data!.conversation!.id!;
  const msgUp = await upload(a, 'message');
  const msg = await api(a, 'POST', `/api/conversations/${conversationId}/messages`, {
    type: 'TEXT',
    content: 'media check',
    attachmentIds: [msgUp.id]
  });
  assert.equal(msg.status, 201, `message with attachment: ${msg.status}`);
  const msgKey = fileKeyOf(msgUp.url);

  await report.check('unauthenticated media requests are rejected (401)', async () => {
    const res = await getFile(null, msgKey);
    assert.equal(res.status, 401);
  });

  await report.check('stored media URLs are always the authenticated proxy (never a public bucket)', async () => {
    assert.ok(msgUp.url.startsWith('/api/files/'), `upload URL should be proxied: ${msgUp.url}`);
    // mediaHref rewrites legacy public S3 URLs to the proxy form.
    process.env.S3_PUBLIC_URL = 'https://pub-legacy.example.com';
    try {
      assert.equal(
        mediaHref('https://pub-legacy.example.com/2026/x.png'),
        '/api/files/2026/x.png',
        'legacy public URL must be rewritten'
      );
      assert.equal(mediaHref('/api/files/2026/y.png'), '/api/files/2026/y.png');
    } finally {
      delete process.env.S3_PUBLIC_URL;
    }
  });

  await report.check('the uploader and conversation members can read message media (200)', async () => {
    assert.equal((await getFile(a, msgKey)).status, 200);
    assert.equal((await getFile(b, msgKey)).status, 200);
  });

  await report.check('unrelated users cannot read message media (404)', async () => {
    const res = await getFile(d, msgKey);
    assert.equal(res.status, 404, `stranger got ${res.status}`);
  });

  await report.check('avatar media is readable by any authenticated user', async () => {
    const avatar = await upload(a, 'avatar');
    const key = fileKeyOf(avatar.url);
    assert.equal((await getFile(d, key)).status, 200);
    assert.equal((await getFile(null, key)).status, 401);
  });

  await report.check('status media is readable by the status audience only', async () => {
    const up = await upload(a, 'status');
    const key = fileKeyOf(up.url);
    const posted = await api(a, 'POST', '/api/status', { type: 'IMAGE', attachmentId: up.id });
    assert.equal(posted.status, 201);
    // A and B are contacts (they share a DM) → B is in A's status audience.
    assert.equal((await getFile(a, key)).status, 200);
    assert.equal((await getFile(b, key)).status, 200);
    // D is a stranger → 404.
    assert.equal((await getFile(d, key)).status, 404);
  });

  await report.check('range requests stream partial content (206)', async () => {
    const res = await getFile(a, msgKey, 'bytes=0-9');
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-length'), '10');
    assert.ok((res.headers.get('content-range') ?? '').startsWith('bytes 0-9/'));
  });

  await report.check('unknown keys and unlinked files are not servable (404)', async () => {
    assert.equal((await getFile(a, '2099/01/does-not-exist.png')).status, 404);
    assert.equal((await getFile(a, '../../etc/passwd')).status, 404);
    assert.equal((await getFile(a, '')).status, 404);
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
