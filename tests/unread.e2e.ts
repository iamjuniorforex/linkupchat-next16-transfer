/**
 * Phase 1 — Unread Experience e2e suite.
 *
 * Covers: 1:1 + group unread counts, sender exclusion, read-up-to-message,
 * forward-only cursor, read receipts (1:1 + group), privacyReadReceipts,
 * late group-join baseline (joinedAt), global unread total, realtime
 * increment/decrement, reconnect reconciliation, and reload survival.
 *
 * Run: SERVER_URL=http://localhost:3300 npm run test:unread:e2e
 *      (requires a running server + seeded users alex/emma/daniel/sarah)
 */
import assert from 'node:assert/strict';
import {
  api,
  conversationsBy,
  connectAndJoin,
  createReporter,
  expectQuiet,
  history,
  login,
  sendText,
  sleep,
  uniq,
  waitFor,
  type Session,
  type WireMessage
} from './helpers';

const { check, finish } = createReporter();

function unreadOf(map: Map<string, Record<string, unknown>>, id: string): number {
  return (map.get(id)?.unreadCount as number | undefined) ?? -1;
}

function sumOf(map: Map<string, Record<string, unknown>>): number {
  let s = 0;
  for (const c of map.values()) s += (c.unreadCount as number | undefined) ?? 0;
  return s;
}

async function markAllRead(s: Session, conversationId: string) {
  const r = await api(s, 'POST', `/api/conversations/${conversationId}/read`, {});
  assert.equal(r.status, 200, `mark-all-read failed (${r.status})`);
}

async function resetAllUnread(s: Session) {
  const map = await conversationsBy(s);
  for (const [id, c] of map) {
    if (((c.unreadCount as number | undefined) ?? 0) > 0) await markAllRead(s, id);
  }
}

async function main() {
  console.log('\n■ SETUP');
  const alex: Session = await login('alex');
  const emma: Session = await login('emma');
  const daniel: Session = await login('daniel');
  const sarah: Session = await login('sarah');
  const n = uniq();

  // ── 1:1 unread + sender exclusion ──
  console.log('\n■ 1:1 unread');
  const dConv = (
    await api<{ data?: { conversation?: { id: string } } }>(alex, 'POST', '/api/conversations', {
      type: 'DIRECT',
      username: 'emma'
    })
  ).json.data!.conversation!.id;
  // Reset stale unread from earlier runs (shared persistent 1:1).
  await markAllRead(emma, dConv);

  for (let i = 1; i <= 3; i++) await sendText(alex, dConv, `unread-1to1-${n}-${i}`, `u-${n}-a${i}`);

  await check('1:1 unread count for the receiver (3)', async () => {
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 3);
  });

  await check('sender messages do not count as unread (sender sees 0)', async () => {
    const map = await conversationsBy(alex);
    assert.equal(unreadOf(map, dConv), 0);
  });

  // ── Group unread ──
  console.log('\n■ Group unread');
  const gA = (
    await api<{ data?: { conversation?: { id: string } } }>(alex, 'POST', '/api/conversations', {
      type: 'GROUP',
      title: `Unread G-A ${n}`,
      memberIds: [alex.id, emma.id]
    })
  ).json.data!.conversation!.id;

  let gABaseline = -1;
  await check('group baseline excludes history (0/1 creation notice only)', async () => {
    gABaseline = unreadOf(await conversationsBy(emma), gA);
    assert.ok(gABaseline >= 0 && gABaseline <= 1, `baseline ${gABaseline}`);
  });

  await check('group unread counts new messages (+2 exactly)', async () => {
    await sendText(alex, gA, 'unread-g1', `u-${n}-g1`);
    await sendText(alex, gA, 'unread-g2', `u-${n}-g2`);
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, gA), gABaseline + 2);
    assert.ok(unreadOf(map, gA) <= 3);
  });

  // ── Read-up-to-message + forward-only cursor ──
  console.log('\n■ Read semantics');
  const three = (await history(emma, dConv)).filter((m) => m.content?.includes(`unread-1to1-${n}`));
  assert.equal(three.length, 3, 'expected three 1:1 messages');
  const [m1, m2, m3] = three as [WireMessage, WireMessage, WireMessage];

  await check('read up to message: only later messages stay unread', async () => {
    await api(emma, 'POST', `/api/conversations/${dConv}/read`, { messageId: m2.id });
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 1, 'exactly the message after m2 remains unread');
  });

  await check('cursor is forward-only (older mark is a no-op)', async () => {
    const r = await api<{ data?: { advanced?: boolean } }>(
      emma,
      'POST',
      `/api/conversations/${dConv}/read`,
      { messageId: m1.id }
    );
    assert.equal(r.json.data?.advanced, false);
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 1, 'cursor must not move backwards');
  });

  await check('reading up to the newest message clears unread', async () => {
    await api(emma, 'POST', `/api/conversations/${dConv}/read`, { messageId: m3.id });
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 0);
  });

  // ── Read receipts 1:1 ──
  const sockAlex = await connectAndJoin(alex, [dConv, gA]);
  await check('1:1 read receipt delivered to the sender (realtime)', async () => {
    await sendText(alex, dConv, 'receipt-1to1', `u-${n}-r1`);
    const last = (await history(emma, dConv)).at(-1)!;
    const wait = waitFor<{ userId: string; conversationId: string; messageId: string | null }>(
      sockAlex,
      'message:read'
    );
    await api(emma, 'POST', `/api/conversations/${dConv}/read`, { messageId: last.id });
    const payload = await wait;
    assert.equal(payload.userId, emma.id, 'receipt carries the reader id');
    assert.equal(payload.conversationId, dConv);
    assert.equal(payload.messageId, last.id, 'receipt carries the read-up-to message');
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 0);
  });

  // ── Late group join baseline (joinedAt) ──
  console.log('\n■ Late group join baseline');
  const gB = (
    await api<{ data?: { conversation?: { id: string } } }>(alex, 'POST', '/api/conversations', {
      type: 'GROUP',
      title: `Unread G-B ${n}`,
      memberIds: [alex.id, sarah.id]
    })
  ).json.data!.conversation!.id;
  for (let i = 1; i <= 5; i++) await sendText(alex, gB, `prejoin-${i}`, `u-${n}-p${i}`);

  let baseline = -1;
  await check('late joiner does not inherit pre-join history', async () => {
    await api(alex, 'POST', `/api/conversations/${gB}/members`, { userIds: [emma.id] });
    const map = await conversationsBy(emma);
    baseline = unreadOf(map, gB);
    assert.ok(baseline >= 0 && baseline <= 1, `baseline ${baseline} should be 0/1 (join notice only)`);
  });

  await check('messages after joining count normally (baseline + 2)', async () => {
    await sendText(alex, gB, 'postjoin-1', `u-${n}-q1`);
    await sendText(alex, gB, 'postjoin-2', `u-${n}-q2`);
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, gB), baseline + 2, `got ${unreadOf(map, gB)}, baseline ${baseline}`);
    assert.ok(unreadOf(map, gB) <= 3, 'pre-join texts must not be included');
  });

  // ── Global unread total (controlled state) ──
  console.log('\n■ Global unread total');
  await resetAllUnread(emma);
  await resetAllUnread(alex);

  await check('global total is zero after clearing', async () => {
    assert.equal(sumOf(await conversationsBy(emma)), 0);
    assert.equal(sumOf(await conversationsBy(alex)), 0);
  });

  await sendText(alex, dConv, 'global-1to1-1', `u-${n}-x1`);
  await sendText(alex, dConv, 'global-1to1-2', `u-${n}-x2`);
  await sendText(alex, gA, 'global-g-1', `u-${n}-y1`);
  await sendText(alex, gA, 'global-g-2', `u-${n}-y2`);
  await sendText(alex, gA, 'global-g-3', `u-${n}-y3`);

  await check('global total spans 1:1 + groups (5)', async () => {
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 2);
    assert.equal(unreadOf(map, gA), 3);
    assert.equal(unreadOf(map, gB), 0);
    assert.equal(sumOf(map), 5);
  });

  await check('sender global total excludes own messages (0)', async () => {
    assert.equal(sumOf(await conversationsBy(alex)), 0);
  });

  // ── Realtime increment ──
  console.log('\n■ Realtime consistency');
  const sockEmma = await connectAndJoin(emma, [dConv, gA, gB]);

  await check('MESSAGE_NEW increments per-conversation and global unread', async () => {
    const wait = waitFor<WireMessage>(sockEmma, 'message:new');
    await sendText(alex, dConv, 'rt-inc', `u-${n}-z1`);
    const wire = await wait;
    assert.equal(wire.senderId, alex.id, 'senderId preserved');
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 3, 'per-conversation unread +1');
    assert.equal(sumOf(map), 6, 'global unread +1');
  });

  // ── Realtime decrement + group read receipt ──
  await check('marking read decrements per-conversation and global unread', async () => {
    await markAllRead(emma, dConv);
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 0);
    assert.equal(sumOf(map), 3);
  });

  await check('group read receipt delivered to members (realtime)', async () => {
    const wait = waitFor<{ userId: string; conversationId: string; messageId: string | null }>(
      sockAlex,
      'message:read'
    );
    await markAllRead(emma, gA);
    const payload = await wait;
    assert.equal(payload.userId, emma.id);
    assert.equal(payload.conversationId, gA);
    const map = await conversationsBy(emma);
    assert.equal(sumOf(map), 0, 'all read after clearing gA too');
  });

  // ── privacyReadReceipts ──
  console.log('\n■ privacyReadReceipts');
  await check('reads are recorded but never announced when privacy is off', async () => {
    await api(emma, 'PATCH', '/api/users/me/settings', { privacyReadReceipts: false });
    await sendText(alex, dConv, 'priv-1', `u-${n}-pv1`);
    const last = (await history(emma, dConv)).at(-1)!;
    assert.equal(unreadOf(await conversationsBy(emma), dConv), 1);

    const quiet = expectQuiet(sockAlex, 'message:read', 1200);
    await api(emma, 'POST', `/api/conversations/${dConv}/read`, { messageId: last.id });
    assert.equal(await quiet, true, 'no message:read broadcast with privacy off');

    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, dConv), 0, 'read still recorded (cursor advanced)');
    await api(emma, 'PATCH', '/api/users/me/settings', { privacyReadReceipts: true });
  });

  // ── Reconnect reconciliation + reload survival ──
  console.log('\n■ Reconnect / reload');
  sockEmma.disconnect();
  await sendText(alex, gA, 'recon-1', `u-${n}-rc1`);
  await sendText(alex, gA, 'recon-2', `u-${n}-rc2`);
  await sendText(alex, gA, 'recon-3', `u-${n}-rc3`);

  await check('server truth survives while offline (3 unread)', async () => {
    const map = await conversationsBy(emma);
    assert.equal(unreadOf(map, gA), 3);
    assert.equal(sumOf(map), 3);
  });

  await check('unread survives a fresh reload/login', async () => {
    const reloaded = await login('emma');
    const map = await conversationsBy(reloaded);
    assert.equal(unreadOf(map, gA), 3);
  });

  await check('reconnect reconciles against server truth', async () => {
    const fresh = await login('emma');
    const sock2 = await connectAndJoin(fresh, [gA]);
    const map = await conversationsBy(fresh);
    assert.equal(unreadOf(map, gA), 3, 'still 3 after reconnecting');
    await markAllRead(fresh, gA);
    assert.equal(unreadOf(await conversationsBy(fresh), gA), 0);
    sock2.disconnect();
  });

  sockAlex.disconnect();
  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
