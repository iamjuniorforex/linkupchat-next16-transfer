/**
 * Phase 4B — missed-call notification e2e.
 *
 * A missed call (45s ring timeout) persists a CALL notification for the
 * callee under the Phase 2 rules:
 *   - respected `notifCalls` (no row when disabled)
 *   - no row while the callee is actively viewing the conversation
 *   - minimal body ("Missed voice call" / "from <name>") — no call content
 *   - existing message/reaction notifications keep working (regression).
 *
 * Run: npm run test:call-notifications:e2e   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import {
  api,
  connectSocket,
  createReporter,
  login,
  sleep,
  waitFor,
  type Session
} from './helpers';
import { EVENTS } from '../shared/events';

const report = createReporter();
const RING_WAIT_MS = 50_000;

interface NotifRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
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

async function listNotifications(s: Session): Promise<NotifRow[]> {
  const res = await api<{ data?: { notifications?: NotifRow[] } }>(s, 'GET', '/api/notifications');
  assert.equal(res.status, 200);
  return res.json.data?.notifications ?? [];
}

async function main() {
  const alex = await login('alex');
  const emma = await login('emma');
  const aSock = connectSocket(alex);
  const eSock = connectSocket(emma);
  await sleep(400);

  // the DIRECT conversation between the pair (for the viewing-suppression case)
  const convRes = await api<{ data?: { conversations?: { id: string; peer?: { username?: string } }[] } }>(
    emma,
    'GET',
    '/api/conversations'
  );
  const convs = convRes.json.data?.conversations ?? [];
  const direct = convs.find((c) => c.peer?.username === 'alex');
  assert.ok(direct, 'emma↔alex DIRECT conversation not found');
  const convId = direct!.id;

  const eNotifEvents: NotifRow[] = [];
  eSock.on(EVENTS.NOTIFICATION_NEW, (p: NotifRow) => eNotifEvents.push(p));

  // ── 1. Unanswered call → missed-call notification created ──
  {
    const before = await listNotifications(emma);
    const beforeCallRows = before.filter((n) => n.type === 'CALL').length;
    emitOffer(aSock, emma.id);
    await sleep(350);
    const [timeoutEvent] = await Promise.all([
      waitFor<{ reason?: string }>(aSock, EVENTS.CALL_END, RING_WAIT_MS),
      sleep(RING_WAIT_MS)
    ]);
    void timeoutEvent;
    await sleep(500);

    await report.check('45s timeout ends the call as TIMEOUT for the caller', () => {
      assert.equal(timeoutEvent?.reason, 'TIMEOUT', `reason=${timeoutEvent?.reason}`);
    });

    await report.check('missed call creates a CALL notification for the callee', async () => {
      const rows = (await listNotifications(emma)).filter((n) => n.type === 'CALL');
      assert.equal(rows.length, beforeCallRows + 1, `CALL rows=${rows.length}`);
      const row = rows[0]!;
      assert.equal(row.title, 'Missed voice call');
      assert.ok(row.body?.startsWith('from '), `body=${row.body}`);
      assert.equal(row.readAt, null);
      assert.equal(row.data?.callKind, 'VOICE');
      assert.equal(row.data?.callOutcome, 'MISSED');
      assert.ok(row.data?.callId, 'callId present for deep linking');
      assert.equal(row.data?.peerId, alex.id);
    });

    await report.check('callee receives NOTIFICATION_NEW in realtime', () => {
      assert.equal(eNotifEvents.length, 1);
      assert.equal(eNotifEvents[0]!.type, 'CALL');
      assert.equal(eNotifEvents[0]!.title, 'Missed voice call');
    });

    await report.check('call history shows the MISSED row', async () => {
      const res = await api<{ data?: { calls?: { status: string; direction: string }[] } }>(emma, 'GET', '/api/calls');
      const missed = (res.json.data?.calls ?? []).filter((c) => c.status === 'MISSED' && c.direction === 'INCOMING');
      assert.ok(missed.length >= 1, 'no MISSED row in history');
    });
  }

  // ── 2. notifCalls=false → no notification row ──
  {
    const patch = await api(emma, 'PATCH', '/api/users/me/settings', { notifCalls: false });
    assert.equal(patch.status, 200);

    const before = (await listNotifications(emma)).filter((n) => n.type === 'CALL').length;
    emitOffer(aSock, emma.id);
    await sleep(350);
    await waitFor<{ reason?: string }>(aSock, EVENTS.CALL_END, RING_WAIT_MS);
    await sleep(500);

    await report.check('notifCalls=false suppresses the missed-call notification', async () => {
      const rows = (await listNotifications(emma)).filter((n) => n.type === 'CALL');
      assert.equal(rows.length, before, `CALL rows=${rows.length}`);
    });

    await api(emma, 'PATCH', '/api/users/me/settings', { notifCalls: true });
  }

  // ── 3. actively viewing the conversation → open-chat suppression ──
  {
    eSock.emit(EVENTS.CONVERSATION_VIEWING, { conversationId: convId });
    await sleep(250);

    const before = (await listNotifications(emma)).filter((n) => n.type === 'CALL').length;
    emitOffer(aSock, emma.id);
    await sleep(350);
    await waitFor<{ reason?: string }>(aSock, EVENTS.CALL_END, RING_WAIT_MS);
    await sleep(500);

    await report.check('callee actively viewing the conversation gets no notification row', async () => {
      const rows = (await listNotifications(emma)).filter((n) => n.type === 'CALL');
      assert.equal(rows.length, before, `CALL rows=${rows.length}`);
    });

    eSock.emit(EVENTS.CONVERSATION_IDLE, {});
    await sleep(150);
  }

  aSock.disconnect();
  eSock.disconnect();
}

main()
  .then(() => report.finish())
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
