/**
 * Remediation — message delete leaves media behind (audit MEDIUM #2).
 *
 * Deleting a message used to detach its attachments (messageId -> null) but
 * leave the Attachment rows + storage objects in place, so "deleted" media
 * stayed retrievable by its uploader forever. Now an attachment that
 * EXCLUSIVELY backed the deleted message is removed (object + row) — mirroring
 * the Status-deletion safety model. Anything still shared with a live Status,
 * another message or avatar usage is never touched.
 *
 * Proves: exclusive cleanup + /api/files 404s; shared attachments survive the
 * first delete and are removed with the final reference (both orders);
 * local-storage object cleanup; deletion without attachments; unchanged
 * delete authorization. (R2/S3 object deletion through the storage
 * abstraction is covered by tests/storage-s3.test.ts.)
 *
 * Run: npm run test:message-attachments   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, createReporter, login, type Session } from './helpers';

const report = createReporter();
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';

// Minimal bytes that pass the strict content sniffer as a PNG.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

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

async function fileStatus(s: Session | null, url: string): Promise<number> {
  const res = await fetch(`${SERVER_URL}${url}`, {
    headers: s ? { Cookie: s.cookie } : {}
  });
  return res.status;
}

function localPathOf(url: string): string {
  const key = url.replace(/^\/api\/files\//, '');
  return path.resolve(process.env.UPLOAD_DIR ?? './uploads', key);
}

async function main() {
  console.log('■ message-attachments: deleting a message cleans up its exclusive media');
  const stamp = Date.now().toString(36);

  const a = await register(`ma_a${stamp}`, 'Media A');
  const p = await register(`ma_p${stamp}`, 'Media P');
  const o = await register(`ma_o${stamp}`, 'Media O'); // outsider, never in the DM

  const convRes = await api<{ data?: { conversation?: { id?: string } } }>(
    a,
    'POST',
    '/api/conversations',
    { type: 'DIRECT', username: p.username }
  );
  const convId = convRes.json.data?.conversation?.id;
  assert.ok(convId, 'DM not created');

  // ── 1+2+5: exclusive attachment is removed with its message ──────────────
  await report.check('deleting a message removes its exclusive attachment', async () => {
    const up = await upload(a, 'message');
    const existedBefore = fs.existsSync(localPathOf(up.url));

    const sent = await api<{ data?: { message?: { id?: string } } }>(
      a,
      'POST',
      `/api/conversations/${convId}/messages`,
      { type: 'IMAGE', attachmentIds: [up.id] }
    );
    assert.equal(sent.status, 201);
    const messageId = sent.json.data?.message?.id;
    assert.ok(messageId);

    // Reachable while the message exists (member + uploader).
    assert.equal(await fileStatus(a, up.url), 200);
    assert.equal(await fileStatus(p, up.url), 200);

    const del = await api(a, 'DELETE', `/api/messages/${messageId}`);
    assert.equal(del.status, 200);

    // Gone for everyone — including the uploader (who could always fetch
    // their own uploads: 404 here proves the attachment itself was removed).
    assert.equal(await fileStatus(a, up.url), 404, 'uploader still reaches deleted media');
    assert.equal(await fileStatus(p, up.url), 404, 'member still reaches deleted media');
    assert.equal(await fileStatus(null, up.url), 401);

    // Local-storage object cleanup (skip when the server stores elsewhere).
    if (existedBefore) {
      assert.equal(fs.existsSync(localPathOf(up.url)), false, 'storage object survived delete');
    }
  });

  // ── 7: plain text messages still delete fine ─────────────────────────────
  await report.check('deleting a message without attachments still works', async () => {
    const sent = await api<{ data?: { message?: { id?: string } } }>(
      a,
      'POST',
      `/api/conversations/${convId}/messages`,
      { type: 'TEXT', content: 'plain text' }
    );
    assert.equal(sent.status, 201);
    const del = await api(a, 'DELETE', `/api/messages/${sent.json.data?.message?.id}`);
    assert.equal(del.status, 200);
  });

  // ── 3+4: shared attachment survives the message delete (status holds it) ─
  const shared = await upload(a, 'status');
  const statusRes = await api<{ data?: { status?: { id?: string } } }>(a, 'POST', '/api/status', {
    type: 'IMAGE',
    attachmentId: shared.id
  });
  assert.equal(statusRes.status, 201);
  const sharedMsg = await api<{ data?: { message?: { id?: string } } }>(
    a,
    'POST',
    `/api/conversations/${convId}/messages`,
    { type: 'IMAGE', attachmentIds: [shared.id] }
  );
  assert.equal(sharedMsg.status, 201);

  await report.check('shared attachment remains available to its remaining reference', async () => {
    const del = await api(a, 'DELETE', `/api/messages/${sharedMsg.json.data?.message?.id}`);
    assert.equal(del.status, 200);
    // The live Status still references it — media must survive.
    assert.equal(await fileStatus(a, shared.url), 200, 'shared media vanished with the message');
  });

  await report.check('deleting the final reference removes the attachment', async () => {
    const del = await api(a, 'DELETE', `/api/status/${statusRes.json.data?.status?.id}`);
    assert.equal(del.status, 200);
    assert.equal(await fileStatus(a, shared.url), 404, 'media survived its final reference');
    assert.equal(await fileStatus(p, shared.url), 404);
  });

  // ── reverse order: status deleted first, message is the final reference ──
  await report.check('shared media survives status delete, dies with the message', async () => {
    const up = await upload(a, 'status');
    const st = await api<{ data?: { status?: { id?: string } } }>(a, 'POST', '/api/status', {
      type: 'IMAGE',
      attachmentId: up.id
    });
    assert.equal(st.status, 201);
    const msg = await api<{ data?: { message?: { id?: string } } }>(
      a,
      'POST',
      `/api/conversations/${convId}/messages`,
      { type: 'IMAGE', attachmentIds: [up.id] }
    );
    assert.equal(msg.status, 201);

    const delStatus = await api(a, 'DELETE', `/api/status/${st.json.data?.status?.id}`);
    assert.equal(delStatus.status, 200);
    // Message still references it: member (message scope) keeps access.
    assert.equal(await fileStatus(p, up.url), 200, 'media vanished with the status');

    const delMsg = await api(a, 'DELETE', `/api/messages/${msg.json.data?.message?.id}`);
    assert.equal(delMsg.status, 200);
    assert.equal(await fileStatus(p, up.url), 404);
    assert.equal(await fileStatus(a, up.url), 404);
  });

  // ── delete authorization unchanged ───────────────────────────────────────
  await report.check('non-sender message delete is still forbidden', async () => {
    const sent = await api<{ data?: { message?: { id?: string } } }>(
      a,
      'POST',
      `/api/conversations/${convId}/messages`,
      { type: 'TEXT', content: 'mine' }
    );
    const del = await api(p, 'DELETE', `/api/messages/${sent.json.data?.message?.id}`);
    assert.equal(del.status, 403);
    const delOutsider = await api(o, 'DELETE', `/api/messages/${sent.json.data?.message?.id}`);
    assert.equal(delOutsider.status, 403);
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
