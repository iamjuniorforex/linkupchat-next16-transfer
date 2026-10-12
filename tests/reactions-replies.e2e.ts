/**
 * Phase 3 — Message reactions + replies e2e (HTTP + Socket.IO).
 *
 * Covers: react / change (replace) / remove, one reaction per user, counts +
 * userIds visible to both sides, emoji whitelist, non-member 403, no
 * duplicate rows under duplicated client events, realtime MESSAGE_REACTION
 * payload sufficiency, reply persistence + quote fields, deleted-quote
 * preview, invalid reply targets.
 *
 * Run: npm run test:reactions:e2e   (SERVER_URL=http://localhost:3300)
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
  sleep,
  uniq,
  waitFor,
  type Session,
  type WireMessage
} from './helpers';

const report = createReporter();

interface ReactionRow {
  emoji: string;
  count: number;
  userIds: string[];
  reacted: boolean;
}

interface ReactionEvent {
  messageId: string;
  conversationId: string;
  reactions: { emoji: string; userId: string }[];
  userId: string;
  emoji: string;
  reacted: boolean;
}

type MessageWithExtras = WireMessage & {
  replyToId?: string | null;
  reactions?: ReactionRow[];
  replyTo?: {
    id: string;
    content: string | null;
    type: string;
    senderName: string | null;
    senderId: string | null;
    deletedAt?: boolean;
  } | null;
};

async function sendReply(
  s: Session,
  conversationId: string,
  content: string,
  replyToId?: string
): Promise<string> {
  const res = await api<{ ok?: boolean; data?: { message?: { id?: string } }; error?: { message?: string } }>(
    s,
    'POST',
    `/api/conversations/${conversationId}/messages`,
    { type: 'TEXT', content, clientNonce: `n-${uniq()}`, ...(replyToId ? { replyToId } : {}) }
  );
  assert.ok(res.status === 200 || res.status === 201, `send → HTTP ${res.status}: ${JSON.stringify(res.json.error ?? '')}`);
  return String(res.json.data?.message?.id ?? '');
}

async function react(s: Session, messageId: string, emoji: string) {
  return api<{ ok?: boolean; data?: { reacted?: boolean; reactions?: { emoji: string; userId: string }[] }; error?: { code?: string; message?: string } }>(
    s,
    'POST',
    `/api/messages/${messageId}/reactions`,
    { emoji }
  );
}

async function hist(s: Session, conversationId: string): Promise<MessageWithExtras[]> {
  return (await history(s, conversationId, 20)) as MessageWithExtras[];
}

function reactionsOf(msgs: MessageWithExtras[], id: string): ReactionRow[] {
  return msgs.find((m) => m.id === id)?.reactions ?? [];
}

function ensureDirect(map: Map<string, Record<string, unknown>>, from: Session, peerUsername: string): string {
  for (const c of map.values()) {
    if (String(c.type ?? '') !== 'DIRECT') continue;
    const peer = c.peer as { username?: string } | null;
    if (peer?.username === peerUsername) return String(c.id);
  }
  return '';
}

async function main() {
  const alex = await login('alex');
  const emma = await login('emma');
  const sarah = await login('sarah');

  // Resolve (or create) the alex↔emma direct conversation
  let conv = ensureDirect(await conversationsBy(alex), alex, 'emma');
  if (!conv) {
    const res = await api<{ data?: { conversation?: { id?: string } } }>(alex, 'POST', '/api/conversations', {
      type: 'DIRECT',
      username: 'emma'
    });
    conv = String(res.json.data?.conversation?.id ?? '');
  }
  assert.ok(conv, 'alex↔emma conversation resolved');

  const content = uniq();
  const msgId = await sendReply(alex, conv, content);
  assert.ok(msgId, 'message sent');

  // ── 1. React + counts + userIds (both sides see it) ──
  const r1 = await react(emma, msgId, '👍');
  assert.equal(r1.status, 200, `react → HTTP ${r1.status}`);
  await report.check('react to a message: created', () => {
    assert.equal(r1.json.data?.reacted, true);
    assert.deepEqual(r1.json.data?.reactions, [{ emoji: '👍', userId: emma.id }]);
  });

  let emmaView = await hist(emma, conv);
  let alexView = await hist(alex, conv);
  await report.check('both sides see the reaction with count + userIds', () => {
    const mine = reactionsOf(emmaView, msgId)[0];
    assert.deepEqual(mine, { emoji: '👍', count: 1, userIds: [emma.id], reacted: true });
    const theirs = reactionsOf(alexView, msgId)[0];
    assert.equal(theirs?.count, 1);
    assert.deepEqual(theirs?.userIds, [emma.id]);
    assert.equal(theirs?.reacted, false, 'other viewer must not see it as theirs');
  });

  // ── 2. Multiple users react simultaneously ──
  await Promise.all([react(alex, msgId, '👍'), react(sarah, msgId, '😂').catch(() => null)]);
  // sarah is not a member of this DIRECT chat — her reaction must fail;
  // alex's must succeed. (Membership enforcement checked separately below.)
  emmaView = await hist(emma, conv);
  await report.check('second user reacts: counts aggregate per emoji', () => {
    const rows = reactionsOf(emmaView, msgId);
    const thumbs = rows.find((r) => r.emoji === '👍');
    assert.equal(thumbs?.count, 2);
    assert.deepEqual([...(thumbs?.userIds ?? [])].sort(), [alex.id, emma.id].sort());
  });

  // ── 3. Change reaction → REPLACE (one reaction per user) ──
  const r2 = await react(emma, msgId, '❤️');
  await report.check('changing to another emoji REPLACES the previous one', () => {
    assert.equal(r2.json.data?.reacted, true);
    const rows = r2.json.data?.reactions ?? [];
    assert.deepEqual(rows, [
      { emoji: '👍', userId: alex.id },
      { emoji: '❤️', userId: emma.id }
    ]);
  });
  emmaView = await hist(emma, conv);
  await report.check('after change, user has exactly one reaction', () => {
    const rows = reactionsOf(emmaView, msgId);
    const mine = rows.filter((r) => r.userIds.includes(emma.id));
    assert.equal(mine.length, 1, `user appears in ${mine.length} groups`);
    assert.equal(mine[0]!.emoji, '❤️');
    assert.equal(mine[0]!.reacted, true);
  });

  // ── 4. Same emoji again → REMOVE ──
  const r3 = await react(emma, msgId, '❤️');
  await report.check('selecting the same emoji removes the reaction', () => {
    assert.equal(r3.json.data?.reacted, false);
    assert.deepEqual(r3.json.data?.reactions, [{ emoji: '👍', userId: alex.id }]);
  });

  // ── 5. Emoji whitelist ──
  const bad = await react(emma, msgId, '🦄');
  await report.check('unsupported emoji rejected (422)', () => {
    assert.equal(bad.status, 422, `got HTTP ${bad.status}`);
    assert.equal(bad.json.ok, false);
  });
  const bad2 = await react(emma, msgId, '😡');
  await report.check('old 😡 emoji is no longer accepted', () => {
    assert.equal(bad2.status, 422, `got HTTP ${bad2.status}`);
  });

  // ── 6. Permissions: non-member cannot react ──
  const outsider = await react(sarah, msgId, '👍');
  await report.check('non-member reaction is forbidden (403)', () => {
    assert.equal(outsider.status, 403, `got HTTP ${outsider.status}`);
  });

  // ── 7. Duplicated client events never create duplicate rows ──
  await Promise.all([react(emma, msgId, '😂'), react(emma, msgId, '😂')]);
  emmaView = await hist(emma, conv);
  await report.check('duplicated events → at most one row per (user, emoji)', () => {
    const rows = reactionsOf(emmaView, msgId);
    const joy = rows.find((r) => r.emoji === '😂');
    assert.ok((joy?.count ?? 0) <= 1, `count=${joy?.count}`);
    const mine = rows.filter((r) => r.userIds.includes(emma.id));
    assert.ok(mine.length <= 1, 'user must not accumulate reactions');
    for (const r of rows) {
      assert.equal(new Set(r.userIds).size, r.userIds.length, 'duplicate userIds in a group');
    }
  });

  // ── 8. Realtime MESSAGE_REACTION (sufficient payload, same-id semantics) ──
  const emmaSocket: Socket = await connectAndJoin(emma, [conv]);
  try {
    const waiter = waitFor<ReactionEvent>(emmaSocket, EVENTS.MESSAGE_REACTION);
    await react(alex, msgId, '🙏');
    const evt = await waiter;
    await report.check('MESSAGE_REACTION broadcast reaches conversation members', () => {
      assert.equal(evt.messageId, msgId);
      assert.equal(evt.conversationId, conv);
      assert.ok(Array.isArray(evt.reactions));
    });
    await report.check('payload is sufficient to update without refetching', () => {
      assert.ok(evt.reactions.every((r) => typeof r.emoji === 'string' && typeof r.userId === 'string'));
      assert.ok(evt.reactions.some((r) => r.emoji === '🙏' && r.userId === alex.id));
    });
  } finally {
    emmaSocket.disconnect();
  }

  // ── 9. Replies: persist + quote fields ──
  const replyContent = uniq();
  const replyId = await sendReply(emma, conv, replyContent, msgId);
  const withReply = await hist(emma, conv);
  const replyMsg = withReply.find((m) => m.id === replyId);
  await report.check('reply persists the relationship to the original', () => {
    assert.equal(replyMsg?.replyToId, msgId);
    assert.equal(replyMsg?.replyTo?.id, msgId);
    assert.equal(replyMsg?.replyTo?.senderName, 'Alex Mensah');
    assert.equal(replyMsg?.replyTo?.content, content);
    assert.equal(replyMsg?.replyTo?.deletedAt, false);
  });

  // ── 10. Invalid reply targets ──
  const otherConv = ensureDirect(await conversationsBy(alex), alex, 'sarah');
  let crossStatus = 0;
  if (otherConv) {
    const cross = await api(alex, 'POST', `/api/conversations/${otherConv}/messages`, {
      type: 'TEXT',
      content: uniq(),
      clientNonce: `n-${uniq()}`,
      replyToId: msgId
    });
    crossStatus = cross.status;
  }
  await report.check('reply target from another conversation is rejected', () => {
    assert.ok(otherConv, 'alex↔sarah conversation required');
    assert.equal(crossStatus, 400, `got HTTP ${crossStatus}`);
  });
  const missing = await api(alex, 'POST', `/api/conversations/${conv}/messages`, {
    type: 'TEXT',
    content: uniq(),
    clientNonce: `n-${uniq()}`,
    replyToId: 'nonexistent-message-id'
  });
  await report.check('nonexistent reply target is rejected', () => {
    assert.equal(missing.status, 400, `got HTTP ${missing.status}`);
  });

  // ── 11. Deleted original → quote shows the deleted placeholder ──
  const target2 = await sendReply(alex, conv, uniq());
  const reply2 = await sendReply(emma, conv, uniq(), target2);
  const del = await api(alex, 'DELETE', `/api/messages/${target2}`);
  assert.equal(del.status, 200, `delete → HTTP ${del.status}`);
  const afterDel = (await hist(emma, conv)).find((m) => m.id === reply2);
  await report.check('quote of a deleted message: content hidden, flagged deleted', () => {
    assert.equal(afterDel?.replyTo?.id, target2);
    assert.equal(afterDel?.replyTo?.content, null, 'deleted content must not leak');
    assert.equal(afterDel?.replyTo?.deletedAt, true);
  });

  // ── 12. Reactions survive reconnect/refetch without duplication ──
  const refetch = await hist(emma, conv);
  await report.check('refetch reconciles reactions: unique, stable', () => {
    const rows = reactionsOf(refetch, msgId);
    const pairs = rows.flatMap((r) => r.userIds.map((u) => `${r.emoji}:${u}`));
    assert.equal(new Set(pairs).size, pairs.length, 'duplicate (emoji,user) after refetch');
    assert.ok(rows.some((r) => r.emoji === '🙏'), 'alex reaction lost on refetch');
  });

  // ══════════ PART F — deleted message safety (audit hardening) ══════════
  await report.check('replyTo payload exposes only the safe key set (no URLs/attachments)', () => {
    const quote = (afterDel?.replyTo ?? replyMsg?.replyTo) as Record<string, unknown>;
    assert.ok(quote, 'missing quote');
    const keys = Object.keys(quote).sort();
    assert.deepEqual(
      keys,
      ['content', 'deletedAt', 'id', 'senderId', 'senderName', 'type'],
      `unexpected keys: ${keys.join(',')}`
    );
  });

  // ══════════ PART G — unread / notification compatibility ══════════
  const unreadBeforeReact = Number((await conversationsBy(emma)).get(conv)?.unreadCount ?? -1);
  await react(alex, msgId, '👍');
  const unreadAfterReact = Number((await conversationsBy(emma)).get(conv)?.unreadCount ?? -1);
  await report.check('reactions do NOT increment message unread counts', () => {
    assert.equal(unreadAfterReact, unreadBeforeReact, `unread moved ${unreadBeforeReact} → ${unreadAfterReact}`);
  });

  const feedBefore = (await api<{ data?: { notifications?: unknown[] } }>(emma, 'GET', '/api/notifications')).json;
  await react(alex, msgId, '😂');
  await react(emma, msgId, '😂');
  const feedAfter = (await api<{ data?: { notifications?: unknown[] } }>(emma, 'GET', '/api/notifications')).json;
  await report.check('reactions do NOT create notification-feed rows', () => {
    assert.equal(
      JSON.stringify(feedAfter.data?.notifications ?? []),
      JSON.stringify(feedBefore.data?.notifications ?? []),
      'feed changed after reactions'
    );
  });

  // Replies are ordinary messages → normal unread behavior.
  const unreadBeforeReply = Number((await conversationsBy(emma)).get(conv)?.unreadCount ?? -1);
  const replyForUnread = await sendReply(alex, conv, uniq());
  assert.ok(replyForUnread);
  const unreadAfterReply = Number((await conversationsBy(emma)).get(conv)?.unreadCount ?? -1);
  await report.check('replies behave as ordinary messages for unread counting', () => {
    assert.equal(unreadAfterReply, unreadBeforeReply + 1, `unread ${unreadBeforeReply} → ${unreadAfterReply}`);
    // reset so later assertions are independent of this bump
  });
  await api(emma, 'POST', `/api/conversations/${conv}/read`, {});

  // notifPreview=false: neither the reply text nor the quoted text may appear.
  await api(emma, 'PATCH', '/api/users/me/settings', { notifPreview: false });
  const quotedSecret = `quoted-secret-${uniq()}`;
  const replySecret = `reply-secret-${uniq()}`;
  const quoteTarget = await sendReply(alex, conv, quotedSecret);
  await clearNotificationsHelper(emma);
  await sendReply(alex, conv, replySecret, quoteTarget);
  const notifRes = await api<{ data?: { notifications?: { body?: string | null; data?: unknown }[] } }>(
    emma,
    'GET',
    '/api/notifications'
  );
  await report.check('notifPreview=false: reply notification leaks no reply OR quoted text', () => {
    const dump = JSON.stringify(notifRes.json.data?.notifications ?? []);
    assert.ok(!dump.includes(quotedSecret), 'quoted text leaked into notifications');
    assert.ok(!dump.includes(replySecret), 'reply text leaked into notifications');
  });

  // Aggregation continues to work for rapid replies (Phase 2 intact).
  await clearNotificationsHelper(emma);
  await api(emma, 'PATCH', '/api/users/me/settings', { notifPreview: true });
  await Promise.all([
    sendReply(alex, conv, uniq()),
    sendReply(alex, conv, uniq()),
    sendReply(alex, conv, uniq())
  ]);
  await sleep(150);
  const aggRes = await api<{ data?: { notifications?: { body?: string | null; data?: { conversationId?: string; count?: number } | null }[] } }>(
    emma,
    'GET',
    '/api/notifications'
  );
  await report.check('notification aggregation works for rapid replies (1 row, count=3)', () => {
    const rows = (aggRes.json.data?.notifications ?? []).filter(
      (n) => n.data?.conversationId === conv
    );
    assert.equal(rows.length, 1, `expected 1 aggregated row, got ${rows.length}`);
    assert.equal(rows[0]?.data?.count, 3, `count=${rows[0]?.data?.count}`);
    assert.ok(rows[0]?.body?.startsWith('3 new messages'), `body=${rows[0]?.body}`);
  });
  await clearNotificationsHelper(emma);

  // ══════════ PART H — authorization hardening ══════════
  const missingMsg = await react(emma, 'nonexistent-message', '👍');
  await report.check('reacting to a nonexistent message → 404', () => {
    assert.equal(missingMsg.status, 404, `got HTTP ${missingMsg.status}`);
  });
  const deletedMsg = await react(emma, target2, '👍');
  await report.check('reacting to a deleted message → 404', () => {
    assert.equal(deletedMsg.status, 404, `got HTTP ${deletedMsg.status}`);
  });

  // Spoofed userId in the body must be ignored — only the SESSION user's
  // reaction slot is touched; other users' reactions stay intact.
  await react(alex, msgId, '👍');
  const spoof = await api(emma, 'POST', `/api/messages/${msgId}/reactions`, {
    emoji: '😢',
    userId: alex.id
  });
  assert.equal(spoof.status, 200, `spoof attempt → HTTP ${spoof.status}`);
  await report.check('client-supplied userId is ignored (no cross-user manipulation)', () => {
    const rows = spoof.json as { data?: { reactions?: { emoji: string; userId: string }[] } };
    const rowsList = rows.data?.reactions ?? [];
    assert.ok(rowsList.some((r) => r.emoji === '😢' && r.userId === emma.id), 'own reaction missing');
    assert.ok(rowsList.some((r) => r.emoji === '👍' && r.userId === alex.id), "alex's reaction was modified");
    assert.ok(!rowsList.some((r) => r.userId === emma.id && r.emoji === '👍'), 'spoofed switch must not happen');
  });

  for (const badEmoji of ['', 'way-too-long-emoji', '👍👍👍👍👍']) {
    const badReq = await react(emma, msgId, badEmoji);
    await report.check(`malformed reaction rejected: ${JSON.stringify(badEmoji)}`, () => {
      assert.equal(badReq.status, 422, `got HTTP ${badReq.status}`);
    });
  }
  const badReply = await api(alex, 'POST', `/api/conversations/${conv}/messages`, {
    type: 'TEXT',
    content: uniq(),
    clientNonce: `n-${uniq()}`,
    replyToId: 12345
  });
  await report.check('malformed (non-string) reply target is rejected', () => {
    assert.ok(badReply.status === 400 || badReply.status === 422, `got HTTP ${badReply.status}`);
  });

  // Removed group member cannot react (leftAt enforcement).
  const gRes = await api<{ data?: { conversation?: { id?: string }; id?: string } }>(
    alex,
    'POST',
    '/api/conversations',
    { type: 'GROUP', memberIds: [emma.id, sarah.id], title: `R3 ${uniq().slice(-5)}` }
  );
  const gId = String(gRes.json.data?.conversation?.id ?? gRes.json.data?.id ?? '');
  assert.ok(gId, 'group created');
  const gMsg = await sendReply(alex, gId, uniq());
  const kick = await api(alex, 'DELETE', `/api/conversations/${gId}/members`, { userId: sarah.id });
  assert.ok(kick.status === 200 || kick.status === 204, `remove member → HTTP ${kick.status}`);
  const kickedReact = await react(sarah, gMsg, '👍');
  await report.check('removed group member cannot react (403)', () => {
    assert.equal(kickedReact.status, 403, `got HTTP ${kickedReact.status}`);
  });

  // ══════════ PART J — true concurrency ══════════
  const cMsg = await sendReply(alex, conv, uniq());

  // J1: two different users react SIMULTANEOUSLY.
  await Promise.all([react(alex, cMsg, '👍'), react(emma, cMsg, '❤️')]);
  const j1 = await hist(emma, conv);
  await report.check('J1: two users reacting simultaneously both land', () => {
    const rows = reactionsOf(j1, cMsg);
    assert.deepEqual(
      rows.flatMap((r) => r.userIds.map((u) => `${r.emoji}:${u}`)).sort(),
      ['👍:' + alex.id, '❤️:' + emma.id].sort()
    );
  });

  // J2: one user CHANGES while another user reacts — simultaneously.
  await Promise.all([react(alex, cMsg, '😂'), react(sarah, cMsg, '😮').catch(() => null)]);
  // (sarah is not a member here → her op is rejected; run the real J2 in the group.)
  await Promise.all([react(alex, cMsg, '🙏'), react(emma, cMsg, '😮')]);
  const j2 = await hist(emma, conv);
  await report.check('J2: change-vs-react race leaves valid per-user state', () => {
    const rows = reactionsOf(j2, cMsg);
    for (const r of rows) {
      assert.equal(r.count, r.userIds.length, 'count must equal userIds length');
      assert.equal(new Set(r.userIds).size, r.userIds.length, 'duplicate userIds');
    }
    const alexRows = rows.filter((r) => r.userIds.includes(alex.id));
    const emmaRows = rows.filter((r) => r.userIds.includes(emma.id));
    assert.equal(alexRows.length, 1, 'alex must have exactly one reaction');
    assert.equal(emmaRows.length, 1, 'emma must have exactly one reaction');
  });

  // J3+J4: rapid toggles + duplicated requests — same user, storm of parallel ops.
  const storm: Promise<unknown>[] = [];
  for (let i = 0; i < 8; i++) storm.push(react(emma, cMsg, i % 2 === 0 ? '😢' : '😢'));
  for (let i = 0; i < 4; i++) storm.push(react(alex, cMsg, '👍'));
  await Promise.all(storm.map((p) => p.catch(() => null)));
  const j3 = await hist(emma, conv);
  await report.check('J3/J4: parallel toggles + retries → no duplicate rows, ≤1 per user', () => {
    const rows = reactionsOf(j3, cMsg);
    for (const r of rows) {
      assert.equal(new Set(r.userIds).size, r.userIds.length, 'duplicate (emoji,user) rows');
      assert.equal(r.count, r.userIds.length);
    }
    for (const uid of [alex.id, emma.id]) {
      const mine = rows.filter((r) => r.userIds.includes(uid));
      assert.ok(mine.length <= 1, `${uid} accumulated ${mine.length} reactions`);
    }
  });

  // J5+J6: DB authoritative + all connected clients converge on the final state.
  const socketA = await connectAndJoin(alex, [conv]);
  const socketB = await connectAndJoin(emma, [conv]);
  try {
    const seenA: ReactionEvent[] = [];
    const seenB: ReactionEvent[] = [];
    socketA.on(EVENTS.MESSAGE_REACTION, (p: ReactionEvent) => seenA.push(p));
    socketB.on(EVENTS.MESSAGE_REACTION, (p: ReactionEvent) => seenB.push(p));

    await Promise.all([
      react(alex, cMsg, '❤️'),
      react(emma, cMsg, '😂'),
      react(alex, cMsg, '😮'),
      react(emma, cMsg, '🙏')
    ].map((p) => p.catch(() => null)));
    await sleep(300);

    const final = await hist(emma, conv);
    const finalPairs = reactionsOf(final, cMsg)
      .flatMap((r) => r.userIds.map((u) => `${r.emoji}:${u}`))
      .sort();
    const lastOf = (evts: ReactionEvent[]) =>
      (evts[evts.length - 1]?.reactions ?? [])
        .map((r) => `${r.emoji}:${r.userId}`)
        .sort();

    await report.check('J5: final DB state is valid (≤1 reaction per user, counts consistent)', () => {
      for (const r of reactionsOf(final, cMsg)) {
        assert.equal(r.count, r.userIds.length);
        assert.equal(new Set(r.userIds).size, r.userIds.length);
      }
      for (const uid of [alex.id, emma.id]) {
        assert.ok(
          reactionsOf(final, cMsg).filter((r) => r.userIds.includes(uid)).length <= 1,
          'user has multiple reactions'
        );
      }
    });
    await report.check('J6: all connected clients converge on the same final state', () => {
      assert.ok(seenA.length > 0 && seenB.length > 0, 'sockets received no events');
      assert.deepEqual(lastOf(seenA), finalPairs, 'alex client did not converge');
      assert.deepEqual(lastOf(seenB), finalPairs, 'emma client did not converge');
    });
  } finally {
    socketA.disconnect();
    socketB.disconnect();
  }
}

async function clearNotificationsHelper(s: Session): Promise<void> {
  await api(s, 'DELETE', '/api/notifications', { all: true });
}

main()
  .then(() => {
    report.finish();
  })
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
