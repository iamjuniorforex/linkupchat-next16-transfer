/**
 * Phase 2 — Notification Center e2e (HTTP + Socket.IO, in-app only).
 *
 * Covers: per-message notification creation (recipient only), burst
 * aggregation ("N new messages", no dup rows), notifPreview privacy (body
 * never stores message text when previews are off), open-chat suppression
 * (no feed alert while actively viewing — Phase 1 unread untouched), full
 * NOTIFICATION_NEW DTO realtime (id → dedupe / roll-up), GET list +
 * unreadCount + ?unread + 50-cap newest-first, PATCH ids | conversationId |
 * all, DELETE ids | all, group + 1:1 titles, refresh persistence, reconnect
 * without duplication.
 *
 * Run: npm run test:notifications:e2e   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import { EVENTS } from '../shared/events';
import {
  api,
  connectAndJoin,
  conversationsBy,
  createReporter,
  history,
  login,
  sendText,
  sleep,
  uniq,
  waitFor,
  type Session
} from './helpers';

const report = createReporter();

interface NotifRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: { conversationId?: string; messageId?: string; count?: number } | null;
  readAt: string | null;
  createdAt: string;
}

async function listNotifications(s: Session, query = ''): Promise<{ items: NotifRow[]; unreadCount: number }> {
  const res = await api<{ ok?: boolean; data?: { notifications?: NotifRow[]; unreadCount?: number }; error?: { message?: string } }>(
    s,
    'GET',
    `/api/notifications${query}`
  );
  assert.equal(res.status, 200, `GET /api/notifications → HTTP ${res.status}`);
  assert.equal(res.json.ok, true, 'GET /api/notifications ok');
  return {
    items: res.json.data?.notifications ?? [],
    unreadCount: Number(res.json.data?.unreadCount ?? -1)
  };
}

async function clearNotifications(s: Session): Promise<void> {
  const res = await api(s, 'DELETE', '/api/notifications', { all: true });
  assert.equal(res.status, 200, `DELETE all → HTTP ${res.status}`);
}

function convType(c: Record<string, unknown>): string {
  return String(c.type ?? '');
}

async function ensureDirect(from: Session, peerUsername: string): Promise<string> {
  for (const c of (await conversationsBy(from)).values()) {
    if (convType(c) !== 'DIRECT') continue;
    const peer = c.peer as { id?: string; username?: string } | null;
    if (peer?.username === peerUsername) return String(c.id);
  }
  const res = await api<{ ok?: boolean; data?: { conversation?: { id?: string }; id?: string }; error?: { message?: string } }>(
    from,
    'POST',
    '/api/conversations',
    { type: 'DIRECT', username: peerUsername }
  );
  const id = res.json.data?.conversation?.id ?? res.json.data?.id ?? '';
  assert.ok(id, `create DIRECT ${from.username}↔${peerUsername} failed: ${JSON.stringify(res.json.error ?? res.json)}`);
  return id;
}

async function unreadOf(s: Session, conversationId: string): Promise<number> {
  const map = await conversationsBy(s);
  return Number(map.get(conversationId)?.unreadCount ?? -1);
}

async function main() {
  const alex = await login('alex');
  const emma = await login('emma');
  const sarah = await login('sarah');

  await clearNotifications(alex);
  await clearNotifications(emma);
  await clearNotifications(sarah);
  await api(emma, 'PATCH', '/api/users/me/settings', { notifPreview: true }); // known baseline

  const conv = await ensureDirect(alex, 'emma');
  assert.ok(conv, 'direct conversation alex↔emma resolved');

  let emmaFeed: { items: NotifRow[]; unreadCount: number };
  let convRows: NotifRow[];

  // ── REGRESSION: rapid (CONCURRENT) burst must aggregate into ONE row ──
  // Production bug: 3 rapid messages created 3 rows (read-modify-write race).
  await clearNotifications(emma);
  const p1 = uniq();
  const p2 = uniq();
  const p3 = uniq();
  await Promise.all([
    sendText(alex, conv, p1, `rapid-${uniq()}`),
    sendText(alex, conv, p2, `rapid-${uniq()}`),
    sendText(alex, conv, p3, `rapid-${uniq()}`)
  ]);
  emmaFeed = await listNotifications(emma);
  convRows = emmaFeed.items.filter((x) => x.data?.conversationId === conv);

  await report.check('REGRESSION: 3 rapid (parallel) messages → exactly 1 notification row', () => {
    assert.equal(convRows.length, 1, `expected 1 row, got ${convRows.length}`);
  });
  await report.check('REGRESSION: aggregated row has count=3', () => {
    assert.equal(convRows[0]?.data?.count, 3, `count=${convRows[0]?.data?.count}`);
  });
  await report.check('REGRESSION: body is "3 new messages · <latest preview>"', () => {
    assert.ok(convRows[0]?.body?.startsWith('3 new messages · '), `body=${convRows[0]?.body}`);
    assert.ok(
      [p1, p2, p3].some((p) => convRows[0]!.body!.includes(p)),
      'preview is not one of the sent texts'
    );
  });
  await report.check('REGRESSION: navigation data + unreadCount stay consistent', () => {
    assert.ok(convRows[0]?.data?.messageId, 'missing messageId');
    assert.equal(emmaFeed.unreadCount, 1);
    assert.equal(convRows[0]?.readAt, null);
  });

  // ── 1:1 notification + burst aggregation (sequential) ──
  await clearNotifications(emma); // isolate from the regression burst above
  const r1 = uniq();
  const r2 = uniq();
  const r3 = uniq();
  await sendText(alex, conv, r1, `notif-${uniq()}`);
  await sendText(alex, conv, r2, `notif-${uniq()}`);
  await sendText(alex, conv, r3, `notif-${uniq()}`);

  emmaFeed = await listNotifications(emma);
  convRows = emmaFeed.items.filter((x) => x.data?.conversationId === conv);

  await report.check('1:1 burst of 3 → ONE aggregated feed entry', () => {
    assert.equal(convRows.length, 1, `expected 1 row, got ${convRows.length}`);
  });
  await report.check('aggregated body says "3 new messages" + latest preview', () => {
    assert.equal(convRows[0]?.body, `3 new messages · ${r3}`);
  });
  await report.check('aggregated data keeps navigation (latest messageId + count)', () => {
    assert.equal(convRows[0]?.data?.count, 3);
    assert.ok(convRows[0]?.data?.messageId, 'missing messageId');
    assert.equal(convRows[0]?.data?.conversationId, conv);
  });
  await report.check('newest entry is unread + title is the sender', () => {
    assert.equal(convRows[0]?.readAt, null);
    assert.equal(convRows[0]?.title, 'Alex Mensah');
  });

  await api(emma, 'PATCH', '/api/notifications', { ids: [convRows[0]!.id] });
  const r4 = uniq();
  await sendText(alex, conv, r4, `notif-${uniq()}`);
  emmaFeed = await listNotifications(emma);
  convRows = emmaFeed.items.filter((x) => x.data?.conversationId === conv);
  await report.check('READ rows never absorb new messages (fresh entry)', () => {
    assert.equal(convRows.length, 2, `expected 2 rows, got ${convRows.length}`);
    assert.equal(convRows[0]?.body, r4);
    assert.equal(convRows[0]?.data?.count, undefined);
  });

  // READ-row + RAPID pair: must form ONE new entry (count=2), read row untouched
  await api(emma, 'PATCH', '/api/notifications', { ids: [convRows[0]!.id] });
  const rs1 = uniq();
  const rs2 = uniq();
  await Promise.all([
    sendText(alex, conv, rs1, `rapid-${uniq()}`),
    sendText(alex, conv, rs2, `rapid-${uniq()}`)
  ]);
  emmaFeed = await listNotifications(emma);
  convRows = emmaFeed.items.filter((x) => x.data?.conversationId === conv);
  await report.check('READ rows never absorb rapid pairs either (one new entry, count=2)', () => {
    assert.equal(convRows.length, 3, `expected 3 rows, got ${convRows.length}`);
    const fresh = convRows.find((x) => x.readAt == null);
    assert.equal(fresh?.data?.count, 2, `fresh count=${fresh?.data?.count}`);
    assert.ok(fresh?.body?.startsWith('2 new messages · '), `body=${fresh?.body}`);
    assert.ok(
      [rs1, rs2].some((p) => fresh!.body!.includes(p)),
      'fresh preview is not one of the pair'
    );
  });

  let alexFeed = await listNotifications(alex);
  await report.check('sender gets NO notification for own message', () => {
    assert.ok(alexFeed.items.every((x) => x.data?.conversationId !== conv));
  });

  // ── Realtime DTO + roll-up (same id replaces, never duplicates) ──
  await clearNotifications(emma);
  const emmaSocket: Socket = await connectAndJoin(emma, [conv]);
  try {
    const waiter = waitFor<NotifRow>(emmaSocket, EVENTS.NOTIFICATION_NEW);
    const r5 = uniq();
    await sendText(alex, conv, r5, `notif-rt-${uniq()}`);
    const evt = await waiter;

    await report.check('NOTIFICATION_NEW received in realtime (full DTO)', () => {
      assert.ok(evt.id && evt.createdAt, 'missing id/createdAt');
      assert.equal(evt.body, r5);
      assert.equal(evt.data?.conversationId, conv);
      assert.equal(evt.readAt, null);
    });

    // second message rolls up into the SAME row → same id, new body
    const waiter2 = waitFor<NotifRow>(emmaSocket, EVENTS.NOTIFICATION_NEW);
    const r6 = uniq();
    await sendText(alex, conv, r6, `notif-rt-${uniq()}`);
    const evt2 = await waiter2;

    await report.check('burst roll-up emits the SAME id with updated body', () => {
      assert.equal(evt2.id, evt.id, 'roll-up must reuse the row id');
      assert.equal(evt2.body, `2 new messages · ${r6}`);
      assert.equal(evt2.data?.count, 2);
    });

    const again = await listNotifications(emma);
    await report.check('replayed/rolled-up events never duplicate the feed', () => {
      const ids = again.items.map((x) => x.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate ids in feed');
      assert.equal(again.items.filter((x) => x.data?.conversationId === conv).length, 1);
      assert.equal(again.unreadCount, 1);
    });

    // ── Reconnect without duplication ──
    emmaSocket.disconnect();
    const emmaSocket2 = await connectAndJoin(emma, [conv]);
    const afterReconnect = await listNotifications(emma);
    await report.check('reconnect: server state stable, no duplicate rows', () => {
      const ids = afterReconnect.items.map((x) => x.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(afterReconnect.items.filter((x) => x.data?.conversationId === conv).length, 1);
    });
    emmaSocket2.disconnect();
  } catch (err) {
    emmaSocket.disconnect();
    throw err;
  }

  // ── notifPreview privacy ──
  await clearNotifications(emma);
  await api(emma, 'PATCH', '/api/users/me/settings', { notifPreview: false });
  const secret = `secret-${uniq()}`;
  await sendText(alex, conv, secret, `notif-${uniq()}`);
  emmaFeed = await listNotifications(emma);
  await report.check('notifPreview=false: stored body has NO message text', () => {
    const row = emmaFeed.items.find((x) => x.data?.conversationId === conv);
    assert.ok(row, 'notification missing');
    assert.equal(row!.body, 'New message');
    assert.ok(!JSON.stringify(row).includes(secret), 'message text leaked into the stored notification');
  });

  const resList = await api<{ data?: { notifications?: unknown[] } }>(emma, 'GET', '/api/notifications');
  await report.check('notifPreview=false: raw API response also has no message text', () => {
    assert.ok(!JSON.stringify(resList.json).includes(secret), 'secret visible via the API');
  });

  // Privacy + aggregation: a RAPID pair with previews off → ONE row,
  // body "2 new messages" — no message text in the aggregate either.
  await clearNotifications(emma);
  const sec1 = `secretA-${uniq()}`;
  const sec2 = `secretB-${uniq()}`;
  await Promise.all([
    sendText(alex, conv, sec1, `rapid-${uniq()}`),
    sendText(alex, conv, sec2, `rapid-${uniq()}`)
  ]);
  emmaFeed = await listNotifications(emma);
  const privRows = emmaFeed.items.filter((x) => x.data?.conversationId === conv);
  await report.check('notifPreview=false + rapid pair: ONE aggregated row, privacy-safe body', () => {
    assert.equal(privRows.length, 1, `expected 1 row, got ${privRows.length}`);
    assert.equal(privRows[0]?.body, '2 new messages', `body=${privRows[0]?.body}`);
    assert.ok(!JSON.stringify(privRows[0]).includes(sec1) && !JSON.stringify(privRows[0]).includes(sec2), 'message text leaked');
    assert.equal(privRows[0]?.data?.count, 2);
  });

  await api(emma, 'PATCH', '/api/users/me/settings', { notifPreview: true });
  await clearNotifications(emma); // isolate: next message starts a fresh entry
  const preview = `preview-${uniq()}`;
  await sendText(alex, conv, preview, `notif-${uniq()}`);
  emmaFeed = await listNotifications(emma);
  await report.check('notifPreview=true: normal preview is present', () => {
    const row = emmaFeed.items.find((x) => x.body === preview);
    assert.ok(row, `preview body missing (got: ${emmaFeed.items.map((x) => x.body).join(' | ')})`);
  });

  // ── unreadCount + ?unread filter + refresh persistence ──
  emmaFeed = await listNotifications(emma);
  const unreadOnly = await listNotifications(emma, '?unread=true');
  await report.check('unreadCount equals unread rows (state stays synced)', () => {
    const rows = emmaFeed.items.filter((x) => x.readAt == null).length;
    assert.equal(emmaFeed.unreadCount, rows, `count=${emmaFeed.unreadCount} rows=${rows}`);
  });
  await report.check('?unread=true returns only unread', () => {
    assert.ok(unreadOnly.items.length > 0);
    assert.ok(unreadOnly.items.every((x) => x.readAt == null));
  });

  // ── PATCH {ids} + refresh persistence ──
  const target = emmaFeed.items.find((x) => x.readAt == null)!;
  const beforeCount = emmaFeed.unreadCount;
  await api(emma, 'PATCH', '/api/notifications', { ids: [target.id] });
  let after = await listNotifications(emma); // fresh GET = "refresh"
  await report.check('mark one read persists across refresh', () => {
    const marked = after.items.find((x) => x.id === target.id);
    assert.ok(marked?.readAt, 'readAt not set after refresh');
  });
  await report.check('unreadCount decremented after mark-one', () => {
    assert.equal(after.unreadCount, beforeCount - 1);
  });

  // ── PATCH {conversationId} — auto-mark-on-open ──
  await sendText(alex, conv, uniq(), `notif-${uniq()}`);
  const conv2 = await ensureDirect(sarah, 'emma');
  assert.ok(conv2, 'direct conversation sarah↔emma resolved');
  await clearNotifications(emma);
  await sendText(alex, conv, uniq(), `notif-${uniq()}`);
  await sendText(sarah, conv2, uniq(), `notif-${uniq()}`);

  await api(emma, 'PATCH', '/api/notifications', { conversationId: conv });
  after = await listNotifications(emma);
  await report.check('opening a chat marks that conversation\u2019s rows read', () => {
    const rows = after.items.filter((x) => x.data?.conversationId === conv);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((x) => x.readAt != null), 'some rows still unread');
  });
  await report.check('other conversations stay unread', () => {
    assert.ok(after.items.some((x) => x.data?.conversationId === conv2 && x.readAt == null));
  });

  // ── PATCH {all} + refresh persistence ──
  await api(emma, 'PATCH', '/api/notifications', { all: true });
  after = await listNotifications(emma);
  await report.check('mark all read persists across refresh', () => {
    assert.ok(after.items.length > 0);
    assert.equal(after.unreadCount, 0);
    assert.ok(after.items.every((x) => x.readAt != null));
  });

  // ── DELETE {ids} + DELETE {all} ──
  const delId = after.items[0]!.id;
  await api(emma, 'DELETE', '/api/notifications', { ids: [delId] });
  after = await listNotifications(emma);
  await report.check('DELETE {ids} removes the row', () => {
    assert.ok(after.items.every((x) => x.id !== delId));
  });
  await clearNotifications(emma);
  after = await listNotifications(emma);
  await report.check('DELETE {all} empties the feed', () => {
    assert.equal(after.items.length, 0);
    assert.equal(after.unreadCount, 0);
  });

  // ── Open-chat suppression (server-side; Phase 1 unread untouched) ──
  const viewerSocket = await connectAndJoin(emma, [conv]);
  try {
    viewerSocket.emit(EVENTS.CONVERSATION_VIEWING, { conversationId: conv });
    await sleep(150); // let the server record the view state
    const unreadBefore = await unreadOf(emma, conv);

    const silent = uniq();
    await sendText(alex, conv, silent, `notif-${uniq()}`);
    await sleep(150);
    emmaFeed = await listNotifications(emma);

    await report.check('notification appears for a CLOSED conversation (baseline elsewhere)', () => {
      // conv2 stays closed for emma → sending there must notify (checked below)
      // and THIS conversation is open → its own row must be absent:
      assert.ok(
        emmaFeed.items.every((x) => x.data?.conversationId !== conv),
        'feed alert created while actively viewing'
      );
      assert.ok(!JSON.stringify(emmaFeed.items).includes(silent), 'suppressed message text surfaced');
    });

    const unreadAfter = await unreadOf(emma, conv);
    await report.check('Phase 1 unread count STILL increments while viewing', () => {
      assert.equal(unreadAfter, unreadBefore + 1, `unread ${unreadBefore} → ${unreadAfter}`);
    });

    // closed conversation → notification DOES appear
    await sendText(sarah, conv2, uniq(), `notif-${uniq()}`);
    await sleep(150);
    emmaFeed = await listNotifications(emma);
    await report.check('notification appears for a conversation that is closed', () => {
      assert.ok(emmaFeed.items.some((x) => x.data?.conversationId === conv2));
    });

    // stop viewing → notifications resume
    viewerSocket.emit(EVENTS.CONVERSATION_IDLE, {});
    await sleep(150);
    const resume = uniq();
    await sendText(alex, conv, resume, `notif-${uniq()}`);
    await sleep(150);
    emmaFeed = await listNotifications(emma);
    await report.check('after leaving the chat, notifications resume', () => {
      const row = emmaFeed.items.find((x) => x.data?.conversationId === conv);
      assert.ok(row, 'no row after leaving');
      assert.ok(row!.body === resume || row!.body?.includes(resume), `body=${row!.body}`);
    });

    // active view is per conversation: viewing conv must not suppress conv2
    viewerSocket.emit(EVENTS.CONVERSATION_VIEWING, { conversationId: conv });
    await sleep(150);
    await clearNotifications(emma); // isolate the cross-chat check
    const cross = uniq();
    await sendText(sarah, conv2, cross, `notif-${uniq()}`);
    await sleep(150);
    emmaFeed = await listNotifications(emma);
    await report.check('viewing one chat does not suppress another chat\u2019s alerts', () => {
      const rows = emmaFeed.items.filter((x) => x.data?.conversationId === conv2);
      assert.equal(rows.length, 1, `expected 1 conv2 row, got ${rows.length}`);
      assert.ok(rows[0]!.body?.includes(cross), `body=${rows[0]!.body}`);
    });
  } finally {
    viewerSocket.emit(EVENTS.CONVERSATION_IDLE, {});
    viewerSocket.disconnect();
  }

  // ── Group notification ──
  await clearNotifications(emma);
  await clearNotifications(sarah);
  const gRes = await api<{ data?: { conversation?: { id?: string }; id?: string } }>(
    alex,
    'POST',
    '/api/conversations',
    { type: 'GROUP', memberIds: [emma.id, sarah.id], title: `Squad ${uniq().slice(-5)}` }
  );
  const groupId = gRes.json.data?.conversation?.id ?? gRes.json.data?.id ?? '';
  assert.ok(groupId, 'group created');
  const gMsg = uniq();
  await sendText(alex, groupId, gMsg, `notif-${uniq()}`);

  const emmaGroup = await listNotifications(emma);
  const sarahGroup = await listNotifications(sarah);
  await report.check('group message notifies every other member', () => {
    assert.ok(emmaGroup.items.some((x) => x.data?.conversationId === groupId && x.body?.includes(gMsg)));
    assert.ok(sarahGroup.items.some((x) => x.data?.conversationId === groupId && x.body?.includes(gMsg)));
  });
  await report.check('group title says "sender in <group>"', () => {
    const row = emmaGroup.items.find((x) => x.data?.conversationId === groupId);
    assert.ok(row?.title.startsWith('Alex Mensah in Squad'), `title=${row?.title}`);
  });
  await report.check('group sender gets no notification', async () => {
    const alexNow = await listNotifications(alex);
    assert.ok(
      alexNow.items.every((x) => x.data?.conversationId !== groupId),
      'sender feed contains group rows'
    );
  });

  // ── GET caps at 50 newest-first (aggregation bypassed via mark-read) ──
  await clearNotifications(emma);
  for (let i = 0; i < 55; i++) {
    await sendText(alex, conv, uniq(), `cap-${uniq()}-${i}`);
    await api(emma, 'PATCH', '/api/notifications', { all: true }); // stop roll-up
    if (i % 20 === 19) await sleep(30);
  }
  const capFeed = await listNotifications(emma);
  await report.check('GET returns at most 50 rows', () => {
    assert.ok(capFeed.items.length <= 50, `got ${capFeed.items.length}`);
    assert.ok(capFeed.items.length >= 45, `got only ${capFeed.items.length}`);
  });
  await report.check('capped list still newest first', () => {
    const seq = capFeed.items.map((x) => Date.parse(x.createdAt));
    assert.ok(seq.every((t, i) => i === 0 || seq[i - 1]! >= t), 'timestamps not descending');
  });
  await clearNotifications(emma);

  // ── Messaging intact after the notification flow (guard) ──
  const msgs = await history(emma, conv, 5);
  await report.check('message history intact after notification flow', () => {
    assert.ok(msgs.length > 0);
  });
}

main()
  .then(() => {
    report.finish();
  })
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
