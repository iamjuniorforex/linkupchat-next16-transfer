/**
 * Phase 3.1 — Reaction notifications for AWAY message authors (HTTP +
 * Socket.IO). Reuses the Phase 2 notification infrastructure (REACTION type
 * exists in the schema enum — no migration).
 *
 * Covers: away author gets "X reacted E to your message" (group: "in Family"),
 * open-chat suppression, notifPreview privacy (no message text when off),
 * emoji change updates the same row, unreact deletes it, author-only
 * recipient, self-reactions ignored, left authors not notified, separate
 * from message unread counts, auto-mark on open, deep-link data.
 *
 * Run: npm run test:reaction-notifications:e2e
 */
import assert from 'node:assert/strict';
import {
  api,
  conversationsBy,
  createReporter,
  login,
  sleep,
  uniq,
  type Session
} from './helpers';
import { EVENTS } from '../shared/events';
import { connectAndJoin, waitFor } from './helpers';

const report = createReporter();

interface NotifRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: { conversationId?: string; messageId?: string; reactorId?: string; emoji?: string } | null;
  readAt: string | null;
  createdAt: string;
}

async function feed(s: Session): Promise<{ items: NotifRow[]; unreadCount: number }> {
  const res = await api<{ data?: { notifications?: NotifRow[]; unreadCount?: number } }>(
    s,
    'GET',
    '/api/notifications'
  );
  assert.equal(res.status, 200, `GET /api/notifications → HTTP ${res.status}`);
  return { items: res.json.data?.notifications ?? [], unreadCount: Number(res.json.data?.unreadCount ?? -1) };
}

async function clearFeed(s: Session): Promise<void> {
  await api(s, 'DELETE', '/api/notifications', { all: true });
}

async function displayName(s: Session): Promise<string> {
  const res = await api<{ data?: { displayName?: string }; user?: { displayName?: string } }>(
    s,
    'GET',
    '/api/auth/me'
  );
  return res.json.data?.displayName ?? res.json.user?.displayName ?? s.username;
}

function convType(c: Record<string, unknown>): string {
  return String(c.type ?? '');
}

async function ensureDirect(from: Session, peerUsername: string): Promise<string> {
  for (const c of (await conversationsBy(from)).values()) {
    if (convType(c) !== 'DIRECT') continue;
    const peer = c.peer as { username?: string } | null;
    if (peer?.username === peerUsername) return String(c.id);
  }
  const res = await api<{ data?: { conversation?: { id?: string }; id?: string } }>(
    from,
    'POST',
    '/api/conversations',
    { type: 'DIRECT', username: peerUsername }
  );
  return String(res.json.data?.conversation?.id ?? res.json.data?.id ?? '');
}

async function sendMsg(s: Session, conversationId: string, content: string): Promise<string> {
  const res = await api<{ data?: { message?: { id?: string } } }>(
    s,
    'POST',
    `/api/conversations/${conversationId}/messages`,
    { type: 'TEXT', content, clientNonce: `rn-${uniq()}` }
  );
  assert.ok(res.status === 200 || res.status === 201, `send → HTTP ${res.status}`);
  const id = String(res.json.data?.message?.id ?? '');
  assert.ok(id, 'created message id present');
  return id;
}

async function unreadOf(s: Session, conversationId: string): Promise<number> {
  return Number((await conversationsBy(s)).get(conversationId)?.unreadCount ?? -1);
}

async function react(s: Session, messageId: string, emoji: string) {
  return api(s, 'POST', `/api/messages/${messageId}/reactions`, { emoji });
}

function reactionRows(items: NotifRow[], messageId: string): NotifRow[] {
  return items.filter((n) => n.type === 'REACTION' && n.data?.messageId === messageId);
}

async function main() {
  const alex = await login('alex'); // author (recipient of reaction notifications)
  const emma = await login('emma'); // reactor
  const sarah = await login('sarah'); // third party / group mate

  const emmaName = await displayName(emma);
  assert.ok(emmaName, 'reactor display name resolved');
  const conv = await ensureDirect(alex, 'emma');
  assert.ok(conv, 'alex↔emma conversation resolved');

  await clearFeed(alex);
  await clearFeed(emma);
  await clearFeed(sarah);
  await api(alex, 'PATCH', '/api/users/me/settings', { notifPreview: true });

  // ── 1. Away author gets a notification ("John reacted ❤️ to your message") ──
  const secret = `secret-${uniq()}`;
  const msgId = await sendMsg(alex, conv, secret);

  await react(emma, msgId, '❤️');
  let alexFeed = await feed(alex);
  let rows = reactionRows(alexFeed.items, msgId);

  await report.check('away author gets a REACTION notification row', () => {
    assert.equal(rows.length, 1, `expected 1 row, got ${rows.length}`);
    assert.equal(rows[0]!.type, 'REACTION');
  });
  await report.check('title: "<name> reacted <emoji>"', () => {
    assert.equal(rows[0]!.title, `${emmaName} reacted ❤️`, `title=${rows[0]!.title}`);
  });
  await report.check('body: "to your message" (direct, with preview)', () => {
    assert.equal(rows[0]!.body, `to your message: ${secret}`, `body=${rows[0]!.body}`);
  });
  await report.check('deep-link data: conversation + message + reactor + emoji', () => {
    assert.equal(rows[0]!.data?.conversationId, conv);
    assert.equal(rows[0]!.data?.messageId, msgId);
    assert.equal(rows[0]!.data?.reactorId, emma.id);
    assert.equal(rows[0]!.data?.emoji, '❤️');
  });

  await report.check('message unread count is NOT incremented by reactions', async () => {
    // alex sent the message himself → his conversation unread stays 0
    assert.equal(await unreadOf(alex, conv), 0);
  });
  await report.check('notification unread count includes the reaction row', () => {
    assert.equal(alexFeed.unreadCount, 1);
  });

  // ── 2. Emoji change updates the SAME row (no duplicates) ──
  await react(emma, msgId, '👍');
  alexFeed = await feed(alex);
  rows = reactionRows(alexFeed.items, msgId);
  await report.check('emoji change updates the same notification row', () => {
    assert.equal(rows.length, 1, `expected 1 row, got ${rows.length}`);
    assert.equal(rows[0]!.title, `${emmaName} reacted 👍`);
    assert.equal(rows[0]!.data?.emoji, '👍');
    assert.equal(alexFeed.unreadCount, 1);
  });

  // ── 3. Unreact deletes the notification ──
  await react(emma, msgId, '👍'); // same emoji → remove
  alexFeed = await feed(alex);
  await report.check('unreact removes the notification row', () => {
    assert.equal(reactionRows(alexFeed.items, msgId).length, 0);
    assert.equal(alexFeed.unreadCount, 0);
  });

  // ── 4. Open-chat suppression (existing Phase 2 view-state) ──
  const viewer = await connectAndJoin(alex, [conv]);
  try {
    viewer.emit(EVENTS.CONVERSATION_VIEWING, { conversationId: conv });
    await sleep(150);
    const silentMsgId = await sendMsg(alex, conv, uniq());
    const waiter = waitFor<{ messageId: string }>(viewer, EVENTS.MESSAGE_REACTION);
    await react(emma, silentMsgId, '😂');
    await waiter; // realtime still flows while viewing

    alexFeed = await feed(alex);
    await report.check('while author is viewing: realtime flows but NO notification row', () => {
      assert.equal(reactionRows(alexFeed.items, silentMsgId).length, 0);
    });

    // stop viewing → notifications resume
    viewer.emit(EVENTS.CONVERSATION_IDLE, {});
    await sleep(150);
    const awayMsgId = await sendMsg(alex, conv, uniq());
    await react(emma, awayMsgId, '🙏');
    alexFeed = await feed(alex);
    await report.check('after leaving the chat, reaction notifications resume', () => {
      const row = reactionRows(alexFeed.items, awayMsgId)[0];
      assert.ok(row, 'no row after leaving');
      assert.equal(row!.title, `${emmaName} reacted 🙏`);
    });
  } finally {
    viewer.emit(EVENTS.CONVERSATION_IDLE, {});
    viewer.disconnect();
  }

  // ── 5. notifPreview privacy ──
  await clearFeed(alex);
  await api(alex, 'PATCH', '/api/users/me/settings', { notifPreview: false });
  const hidden = `hidden-${uniq()}`;
  const hiddenMsgId = await sendMsg(alex, conv, hidden);
  await react(emma, hiddenMsgId, '😮');
  alexFeed = await feed(alex);
  await report.check('notifPreview=false: body has NO message text', () => {
    const row = reactionRows(alexFeed.items, hiddenMsgId)[0];
    assert.ok(row, 'row missing');
    assert.equal(row!.body, 'to your message', `body=${row!.body}`);
    assert.ok(!JSON.stringify(row).includes(hidden), 'message text leaked');
    assert.ok(row!.title.includes('😮'), 'emoji must be shown');
  });
  await api(alex, 'PATCH', '/api/users/me/settings', { notifPreview: true });

  // ── 6. Author-only recipient + self-reactions ignored ──
  await clearFeed(alex);
  await clearFeed(emma);
  await clearFeed(sarah);
  const mineId = await sendMsg(alex, conv, uniq());
  await react(alex, mineId, '👍'); // self-reaction
  await report.check('self-reaction creates NO notification', async () => {
    assert.equal(reactionRows((await feed(alex)).items, mineId).length, 0);
    assert.equal(reactionRows((await feed(emma)).items, mineId).length, 0);
  });

  // ── 7. Group: "to your message in Family" + third members not notified ──
  const gRes = await api<{ data?: { conversation?: { id?: string }; id?: string } }>(
    alex,
    'POST',
    '/api/conversations',
    { type: 'GROUP', memberIds: [emma.id, sarah.id], title: `Family ${uniq().slice(-5)}` }
  );
  const gId = String(gRes.json.data?.conversation?.id ?? gRes.json.data?.id ?? '');
  assert.ok(gId, 'group created');
  const gMsgId = await sendMsg(alex, gId, uniq());
  await react(emma, gMsgId, '😂');
  alexFeed = await feed(alex);
  const gRow = reactionRows(alexFeed.items, gMsgId)[0];
  await report.check('group: body is "to your message in <title>"', () => {
    assert.ok(gRow, 'group reaction row missing');
    assert.ok(gRow!.body?.startsWith('to your message in Family'), `body=${gRow!.body}`);
    assert.equal(gRow!.title, `${emmaName} reacted 😂`);
  });
  await report.check('only the message AUTHOR is notified (not other members)', async () => {
    assert.equal(reactionRows((await feed(sarah)).items, gMsgId).length, 0);
  });

  // ── 8. Left authors are not notified ──
  const sMsgId = await sendMsg(sarah, gId, uniq());
  await api(alex, 'DELETE', `/api/conversations/${gId}/members`, { userId: sarah.id });
  await clearFeed(sarah);
  await react(emma, sMsgId, '😢');
  await report.check('authors who left the group are NOT notified', async () => {
    assert.equal(reactionRows((await feed(sarah)).items, sMsgId).length, 0);
  });

  // ── 9. Existing read mechanisms clear the reaction notification ──
  await api(alex, 'PATCH', '/api/notifications', { conversationId: gId });
  alexFeed = await feed(alex);
  await report.check('opening the conversation marks reaction rows read (existing mechanism)', () => {
    const row = reactionRows(alexFeed.items, gMsgId)[0];
    assert.ok(row?.readAt, 'reaction row not marked read by conversation open');
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
