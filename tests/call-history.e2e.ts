/**
 * Call-history deletion e2e (Socket.IO + HTTP against the running server).
 *
 * Covers: removing your own call-history entry, a third user never being able
 * to delete another user's record, independent per-participant history (the
 * shared Call row survives for the peer), session persistence of the removal,
 * and that deletion never touches messages, notifications, or the call record
 * itself (status/duration/timestamps preserved).
 *
 * Run: npm run test:call-history:e2e   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import { api, connectSocket, createReporter, login, sleep, type Session } from './helpers';
import { EVENTS } from '../shared/events';

const report = createReporter();

function capture<T = unknown>(socket: Socket, event: string): T[] {
  const items: T[] = [];
  socket.on(event, (p: T) => items.push(p));
  return items;
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
}

async function waitFor(label: string, fn: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function emitOffer(socket: Socket, to: string, type: 'VOICE' | 'VIDEO' = 'VOICE') {
  socket.emit(EVENTS.CALL_OFFER, {
    callId: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: '',
    to,
    type,
    sdp: { type: 'offer', sdp: 'v=0-fake' }
  });
}

interface CallRow {
  id: string;
  status: string;
  type: string;
  direction: 'OUTGOING' | 'INCOMING';
  peer: { id: string; displayName?: string } | null;
  durationSec: number;
  endedAt: string | null;
}

async function callsList(s: Session): Promise<CallRow[]> {
  const res = await api<{ data?: { calls?: CallRow[] } }>(s, 'GET', '/api/calls');
  assert.equal(res.status, 200, `GET /api/calls: ${res.status}`);
  return res.json.data?.calls ?? [];
}

async function removeCall(s: Session, id: string): Promise<{ status: number; code?: string }> {
  const res = await api<{ error?: { code?: string } }>(s, 'DELETE', `/api/calls/${id}`);
  return { status: res.status, code: res.json.error?.code };
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

async function main() {
  console.log('■ call-history: per-user deletion');
  const stamp = Date.now().toString(36);
  const a = await register(`cha_${stamp}`, 'Call History A');
  const b = await register(`chb_${stamp}`, 'Call History B');
  const c = await register(`chc_${stamp}`, 'Call History C');

  // Calls require an active DIRECT conversation between the pair.
  const conv = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
    type: 'DIRECT',
    username: b.username
  });
  assert.equal(conv.status, 201, `DIRECT create: ${conv.status}`);
  const conversationId = conv.json.data!.conversation!.id!;

  const msg = await api<{ data?: { message?: { id?: string } } }>(a, 'POST', `/api/conversations/${conversationId}/messages`, {
    type: 'TEXT',
    content: 'History must not touch me'
  });
  assert.equal(msg.status, 201, `send message: ${msg.status}`);

  const aSock = connectSocket(a);
  const bSock = connectSocket(b);
  await Promise.all([connected(aSock), connected(bSock)]);
  // The server registers call handlers after an async room-join on connect;
  // allow a settle beat before the first emit (same timing calls.e2e relies
  // on), and poll for delivery rather than assuming a fixed latency.
  await sleep(700);
  const bOffers = capture<{ callId: string }>(bSock, EVENTS.CALL_OFFER);

  // call1: A calls B, B declines → DECLINED row for both.
  emitOffer(aSock, b.id);
  await waitFor('callee receives the offer', async () => bOffers.length >= 1);
  const call1 = bOffers[0]!.callId;
  bSock.emit(EVENTS.CALL_REJECT, { callId: call1, to: a.id });
  await waitFor('the call reaches a final state', async () =>
    (await callsList(b)).some((r) => r.id === call1 && r.status !== 'RINGING')
  );

  const before = {
    a: await callsList(a),
    b: await callsList(b)
  };
  const row1Before = before.b.find((r) => r.id === call1);

  await report.check('history lists the call for both participants first', () => {
    assert.ok(before.a.some((r) => r.id === call1), 'caller missing call');
    assert.ok(row1Before, 'callee missing call');
    assert.equal(before.a.find((r) => r.id === call1)!.direction, 'OUTGOING');
    assert.equal(row1Before!.direction, 'INCOMING');
  });

  await report.check('a third user cannot delete another user\'s call (404, nothing changes)', async () => {
    const res = await removeCall(c, call1);
    assert.equal(res.status, 404, `status=${res.status}`);
    assert.ok((await callsList(a)).some((r) => r.id === call1), 'caller lost the call');
    assert.ok((await callsList(b)).some((r) => r.id === call1), 'callee lost the call');
  });

  await report.check('unknown call id → 404', async () => {
    const res = await removeCall(a, 'call-does-not-exist');
    assert.equal(res.status, 404);
  });

  await report.check('deleting my own entry removes it from my history', async () => {
    const res = await removeCall(a, call1);
    assert.equal(res.status, 200, `status=${res.status}`);
    assert.ok(!(await callsList(a)).some((r) => r.id === call1), 'still listed for me');
  });

  await report.check("the other participant's history is unaffected (independent)", async () => {
    const rows = await callsList(b);
    const row = rows.find((r) => r.id === call1);
    assert.ok(row, 'callee lost the call');
    assert.equal(row!.status, row1Before!.status, 'status altered');
    assert.equal(row!.durationSec, row1Before!.durationSec, 'duration altered');
    assert.equal(row!.endedAt, row1Before!.endedAt, 'endedAt altered');
    assert.equal(row!.direction, 'INCOMING');
  });

  await report.check('the removal persists across a fresh session (server-authoritative)', async () => {
    const a2 = await login(a.username, 'Passw0rd123');
    assert.ok(!(await callsList(a2)).some((r) => r.id === call1), 'reappeared after re-login');
  });

  await report.check('deletion does not touch messages in the conversation', async () => {
    const res = await api<{ data?: { messages?: { content?: string }[] } }>(a, 'GET', `/api/conversations/${conversationId}/messages`);
    assert.equal(res.status, 200);
    assert.ok(
      (res.json.data?.messages ?? []).some((m) => m.content === 'History must not touch me'),
      'message vanished'
    );
  });

  // call2: A calls B; B's socket disconnects while ringing → MISSED + the
  // missed-call notification for B (the callee).
  emitOffer(aSock, b.id, 'VIDEO');
  await waitFor('second offer', async () => bOffers.length >= 2);
  const call2 = bOffers[1]!.callId;
  assert.notEqual(call2, call1);
  bSock.disconnect();
  await waitFor('the missed call to conclude', async () =>
    (await callsList(a)).some((r) => r.id === call2 && r.status === 'MISSED')
  );
  await waitFor('the missed-call notification', async () => {
    const n = await api<{ data?: { notifications?: { type: string }[] } }>(b, 'GET', '/api/notifications');
    return (n.json.data?.notifications ?? []).some((x) => x.type === 'CALL');
  });

  await report.check('deletion leaves the peer\'s notifications and their history untouched', async () => {
    const notifsBefore = await api<{ data?: { notifications?: { id: string; type: string }[] } }>(b, 'GET', '/api/notifications');
    const callNotifsBefore = (notifsBefore.json.data?.notifications ?? []).filter((n) => n.type === 'CALL');
    assert.ok(callNotifsBefore.length >= 1, 'expected a missed-call notification for the callee');
    assert.ok((await callsList(b)).some((r) => r.id === call2), 'callee missing the missed call');

    // The CALLER removes the missed call from their own history.
    const res = await removeCall(a, call2);
    assert.equal(res.status, 200, `status=${res.status}`);

    const notifsAfter = await api<{ data?: { notifications?: { id: string; type: string }[] } }>(b, 'GET', '/api/notifications');
    const callNotifsAfter = (notifsAfter.json.data?.notifications ?? []).filter((n) => n.type === 'CALL');
    assert.deepEqual(
      callNotifsAfter.map((n) => n.id).sort(),
      callNotifsBefore.map((n) => n.id).sort(),
      'callee notifications changed'
    );
    assert.ok((await callsList(b)).some((r) => r.id === call2), 'callee lost the missed call');
    assert.ok(!(await callsList(a)).some((r) => r.id === call2), 'caller still sees the removed call');
  });

  await report.check('repeat deletion of the same entry is harmless', async () => {
    const res = await removeCall(a, call1);
    assert.equal(res.status, 200, `status=${res.status}`);
    assert.ok(!(await callsList(a)).some((r) => r.id === call1));
    assert.ok((await callsList(b)).some((r) => r.id === call1), 'peer affected by repeat delete');
  });

  aSock.disconnect();
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
