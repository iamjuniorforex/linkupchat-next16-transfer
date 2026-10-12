/**
 * Phase 5B Part 2 — early status deletion e2e (HTTP + realtime).
 *
 * Covers: owner-only delete before the 24h expiry, non-owner rejection,
 * removal from /api/status/me and /api/status feeds, the STATUS_DELETED
 * realtime broadcast to contacts, the attachment lifecycle (exclusive
 * attachments cleaned up; shared ones preserved), and safe handling of
 * already-deleted / expired statuses.
 *
 * Run: npm run test:status:delete   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import { api, connectSocket, createReporter, login, sleep, type Session } from './helpers';
import { EVENTS } from '../shared/events';
import { db } from '../src/lib/db';

const report = createReporter();

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

interface UploadData {
  id: string;
  url: string;
  kind: string;
  mimeType: string;
}

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${process.env.SERVER_URL ?? 'http://localhost:3300'}/api/auth/register`, {
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
  const res = await fetch(`${process.env.SERVER_URL ?? 'http://localhost:3300'}/api/upload`, {
    method: 'POST',
    body: fd,
    headers: { Cookie: s.cookie }
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: UploadData; error?: { code?: string } };
  return { status: res.status, ...json };
}

async function postStatus(s: Session, body: Record<string, unknown>) {
  return api<{ ok?: boolean; data?: { status?: { id: string } }; error?: { code?: string; message?: string } }>(
    s,
    'POST',
    '/api/status',
    body
  );
}

async function myStatusIds(s: Session): Promise<string[]> {
  const res = await api<{ data?: { statuses?: { id: string }[] } }>(s, 'GET', '/api/status/me');
  assert.equal(res.status, 200, `GET /api/status/me: ${res.status}`);
  return (res.json.data?.statuses ?? []).map((x) => x.id);
}

async function feedIds(s: Session): Promise<string[]> {
  const res = await api<{ data?: { groups?: { statuses?: { id: string }[] }[] } }>(s, 'GET', '/api/status');
  assert.equal(res.status, 200, `GET /api/status: ${res.status}`);
  return (res.json.data?.groups ?? []).flatMap((g) => (g.statuses ?? []).map((x) => x.id));
}

function capture<T = unknown>(socket: Socket, event: string): T[] {
  const items: T[] = [];
  socket.on(event, (p: T) => items.push(p));
  return items;
}

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(200);
  }
  throw new Error('condition not met in time');
}

async function main() {
  console.log('■ status-delete: early deletion, authorization, feeds, realtime');
  const stamp = Date.now().toString(36);
  const a = await register(`sda_${stamp}`, 'Status Delete A');
  const b = await register(`sdb_${stamp}`, 'Status Delete B');

  // A and B must be contacts so B is inside A's status audience.
  await api(a, 'POST', '/api/contacts', { userId: b.id });

  await report.check('owner can delete their own status before the 24h expiry', async () => {
    const up = await upload(a, PNG_BYTES, 'status');
    assert.equal(up.status, 200, `upload: ${up.status}`);
    const posted = await postStatus(a, { type: 'IMAGE', attachmentId: up.data!.id });
    assert.equal(posted.status, 201, `post: ${posted.status}`);
    const id = posted.json.data!.status!.id;

    const del = await api<{ ok?: boolean; data?: { deleted?: boolean } }>(a, 'DELETE', `/api/status/${id}`);
    assert.equal(del.status, 200, `delete: ${del.status}`);
    assert.equal(del.json.data?.deleted, true);

    const row = await db.status.findUnique({ where: { id } });
    assert.ok(row?.deletedAt, 'status should be soft-deleted');
  });

  await report.check('non-owner cannot delete (403) and the status survives', async () => {
    const posted = await postStatus(b, { type: 'TEXT', content: 'Bee holds this one', background: 'linear-gradient(135deg, #6D5EF5 0%, #22B8FF 100%)' });
    assert.equal(posted.status, 201, `post: ${posted.status}`);
    const id = posted.json.data!.status!.id;

    const del = await api<{ ok?: boolean; error?: { code?: string } }>(a, 'DELETE', `/api/status/${id}`);
    assert.equal(del.status, 403, `expected 403, got ${del.status}`);
    assert.equal(del.json.error?.code, 'FORBIDDEN');

    const row = await db.status.findUnique({ where: { id } });
    assert.equal(row?.deletedAt ?? null, null, 'status must not be deleted');
  });

  await report.check('deleted status disappears from /api/status/me', async () => {
    const posted = await postStatus(a, { type: 'TEXT', content: 'Goes from me list', background: 'linear-gradient(135deg, #FF6B5E 0%, #F5A623 100%)' });
    const id = posted.json.data!.status!.id;
    assert.ok((await myStatusIds(a)).includes(id), 'should be listed before delete');

    const del = await api(a, 'DELETE', `/api/status/${id}`);
    assert.equal(del.status, 200);
    assert.ok(!(await myStatusIds(a)).includes(id), 'still listed after delete');
  });

  await report.check('deleted status disappears from contacts\' feeds', async () => {
    const posted = await postStatus(b, { type: 'TEXT', content: 'Goes from the feed', background: 'linear-gradient(135deg, #22C77D 0%, #22B8FF 100%)' });
    const id = posted.json.data!.status!.id;
    assert.ok((await feedIds(a)).includes(id), 'contact should see it before delete');

    const del = await api(b, 'DELETE', `/api/status/${id}`);
    assert.equal(del.status, 200);
    assert.ok(!(await feedIds(a)).includes(id), 'still in feed after delete');
  });

  await report.check('STATUS_DELETED realtime event is emitted to contacts', async () => {
    const bSock = connectSocket(b);
    await sleep(700); // server joins the user room asynchronously after connect
    const deleted = capture<{ userId: string; statusId: string }>(bSock, EVENTS.STATUS_DELETED);

    const posted = await postStatus(a, { type: 'TEXT', content: 'Watch me vanish', background: 'linear-gradient(135deg, #8481FB 0%, #FF8A7A 100%)' });
    const id = posted.json.data!.status!.id;
    const del = await api(a, 'DELETE', `/api/status/${id}`);
    assert.equal(del.status, 200);

    await until(() => deleted.some((p) => p.statusId === id));
    const payload = deleted.find((p) => p.statusId === id)!;
    assert.equal(payload.userId, a.id, 'payload should carry the author id');
    bSock.close();
  });

  await report.check('an attachment exclusive to the status is cleaned up safely', async () => {
    const up = await upload(a, PNG_BYTES, 'status');
    const posted = await postStatus(a, { type: 'IMAGE', attachmentId: up.data!.id });
    assert.equal(posted.status, 201);
    const id = posted.json.data!.status!.id;

    const before = await db.attachment.findUnique({ where: { id: up.data!.id } });
    assert.ok(before, 'attachment should exist before delete');

    const del = await api(a, 'DELETE', `/api/status/${id}`);
    assert.equal(del.status, 200);

    const after = await db.attachment.findUnique({ where: { id: up.data!.id } });
    assert.equal(after, null, 'exclusive attachment should be cleaned up');
  });

  await report.check('an attachment referenced elsewhere is never deleted', async () => {
    const up = await upload(a, PNG_BYTES, 'status');
    const posted = await postStatus(a, { type: 'IMAGE', attachmentId: up.data!.id });
    const id = posted.json.data!.status!.id;

    // Reference the same attachment from a real message ("elsewhere").
    const conv = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
      type: 'DIRECT',
      username: b.username
    });
    assert.equal(conv.status, 201, `DIRECT create: ${conv.status}`);
    const msg = await api<{ data?: { message?: { id?: string } } }>(
      a,
      'POST',
      `/api/conversations/${conv.json.data!.conversation!.id!}/messages`,
      { type: 'TEXT', content: 'Attachment is mine too' }
    );
    assert.equal(msg.status, 201, `send message: ${msg.status}`);
    await db.attachment.update({
      where: { id: up.data!.id },
      data: { messageId: msg.json.data!.message!.id! }
    });

    const del = await api(a, 'DELETE', `/api/status/${id}`);
    assert.equal(del.status, 200);

    const after = await db.attachment.findUnique({ where: { id: up.data!.id } });
    assert.ok(after, 'shared attachment must survive the status delete');
    assert.equal(after.messageId, msg.json.data!.message!.id, 'message linkage must be intact');
  });

  await report.check('deleting an already-deleted status is handled safely (404)', async () => {
    const posted = await postStatus(a, { type: 'TEXT', content: 'Double tap delete', background: 'linear-gradient(135deg, #4B38BF 0%, #3DDC97 100%)' });
    const id = posted.json.data!.status!.id;
    const first = await api(a, 'DELETE', `/api/status/${id}`);
    assert.equal(first.status, 200);

    const second = await api<{ ok?: boolean; error?: { code?: string } }>(a, 'DELETE', `/api/status/${id}`);
    assert.equal(second.status, 404, `expected 404, got ${second.status}`);
    assert.equal(second.json.error?.code, 'NOT_FOUND');
  });

  await report.check('expired statuses can still be deleted safely by the owner', async () => {
    const posted = await postStatus(a, { type: 'TEXT', content: 'Expire me first', background: 'linear-gradient(135deg, #F5A623 0%, #FF6B5E 100%)' });
    const id = posted.json.data!.status!.id;
    await db.status.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const del = await api(a, 'DELETE', `/api/status/${id}`);
    assert.equal(del.status, 200, `delete expired: ${del.status}`);
    const row = await db.status.findUnique({ where: { id } });
    assert.ok(row?.deletedAt, 'expired status should end up soft-deleted');
    assert.ok(!(await myStatusIds(a)).includes(id), 'expired+deleted must not be listed');
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
