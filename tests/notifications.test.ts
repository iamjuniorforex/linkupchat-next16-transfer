/**
 * Phase 2 — notification feed math unit tests (merge/dedupe, unread counts,
 * optimistic read marking, deep links, per-conversation filter).
 *
 * Run: npm run test:notifications   (tsx tests/notifications.test.ts)
 */
import assert from 'node:assert/strict';
import {
  NOTIF_AGGREGATE_MAX,
  NOTIF_AGGREGATE_WINDOW_MS,
  NOTIFICATIONS_LIST_CAP,
  applyReadToNotifications,
  buildNotificationBody,
  buildNotificationData,
  countUnreadNotifications,
  hasNotification,
  ingestRealtimeNotification,
  isSafeSegment,
  mediaPlaceholder,
  mergeNotifications,
  notificationDeepLink,
  notificationsForConversation,
  parseNotificationData,
  shouldAggregate,
  buildIncomingCallNotification,
  buildMissedCallNotification
} from '../src/lib/notifications';
import type { NotificationDTO } from '../src/types';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
}

function n(id: string, createdAt: string, opts: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id,
    type: 'MESSAGE',
    title: `title-${id}`,
    body: `body-${id}`,
    data: { conversationId: 'conv-1', messageId: `msg-${id}` },
    readAt: null,
    createdAt,
    ...opts
  };
}

console.log('\n■ Merge + dedupe (repeated NOTIFICATION_NEW events)');

check('merges new notifications newest first', () => {
  const merged = mergeNotifications(
    [n('a', '2026-01-01T00:00:01Z')],
    [n('b', '2026-01-01T00:00:02Z')]
  );
  assert.deepEqual(
    merged.map((x) => x.id),
    ['b', 'a']
  );
});

check('the same event received twice creates NO duplicate', () => {
  const first = mergeNotifications([], [n('a', '2026-01-01T00:00:01Z')]);
  const second = mergeNotifications(first, [n('a', '2026-01-01T00:00:01Z')]);
  assert.equal(second.length, 1);
  assert.equal(hasNotification(second, 'a'), true);
});

check('same id from replay keeps exactly one entry even after many merges', () => {
  let list: NotificationDTO[] = [];
  for (let i = 0; i < 5; i++) list = mergeNotifications(list, [n('a', '2026-01-01T00:00:01Z')]);
  assert.equal(list.length, 1);
});

check('feed is capped to a sane window', () => {
  const many = Array.from({ length: 300 }, (_, i) =>
    n(`id-${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`)
  );
  const merged = mergeNotifications([], many);
  assert.equal(merged.length, NOTIFICATIONS_LIST_CAP);
  // newest kept
  assert.equal(merged[0]!.id, 'id-299');
});

console.log('\n■ Unread counts');

check('counts only unread notifications', () => {
  const list = [
    n('a', '2026-01-01T00:00:01Z'),
    n('b', '2026-01-01T00:00:02Z', { readAt: '2026-01-01T00:00:03Z' }),
    n('c', '2026-01-01T00:00:04Z')
  ];
  assert.equal(countUnreadNotifications(list), 2);
});

check('empty feed counts zero', () => {
  assert.equal(countUnreadNotifications([]), 0);
});

console.log('\n■ Optimistic read marking');

check('marking specific ids only touches those', () => {
  const list = [n('a', '2026-01-01T00:00:01Z'), n('b', '2026-01-01T00:00:02Z')];
  const next = applyReadToNotifications(list, ['a'], '2026-01-02T00:00:00Z');
  assert.equal(next[0]!.readAt, '2026-01-02T00:00:00Z');
  assert.equal(next[1]!.readAt, null);
});

check("marking 'all' reads everything unread", () => {
  const list = [
    n('a', '2026-01-01T00:00:01Z'),
    n('b', '2026-01-01T00:00:02Z', { readAt: '2026-01-01T00:00:03Z' })
  ];
  const next = applyReadToNotifications(list, 'all', '2026-01-02T00:00:00Z');
  assert.equal(countUnreadNotifications(next), 0);
  // already-read timestamp preserved
  assert.equal(next[1]!.readAt, '2026-01-01T00:00:03Z');
});

check('does not mutate the original list', () => {
  const list = [n('a', '2026-01-01T00:00:01Z')];
  applyReadToNotifications(list, 'all');
  assert.equal(list[0]!.readAt, null);
});

console.log('\n■ Realtime ingest (dedupe + aggregation roll-up, no dup/count drift)');

check('new id appends with unreadDelta 1', () => {
  const { list, unreadDelta } = ingestRealtimeNotification([], n('a', '2026-01-01T00:00:01Z'));
  assert.equal(list.length, 1);
  assert.equal(unreadDelta, 1);
});

check('replay of the same event: no duplicate, delta 0', () => {
  const first = ingestRealtimeNotification([], n('a', '2026-01-01T00:00:01Z'));
  const second = ingestRealtimeNotification(first.list, n('a', '2026-01-01T00:00:01Z'));
  assert.equal(second.list.length, 1);
  assert.equal(second.unreadDelta, 0);
});

check('aggregation roll-up (same id, new body) replaces in place, delta 0', () => {
  const first = ingestRealtimeNotification([], n('a', '2026-01-01T00:00:01Z', { body: 'hello' }));
  const rolled = ingestRealtimeNotification(
    first.list,
    n('a', '2026-01-01T00:00:09Z', {
      body: '2 new messages · hello again',
      data: { conversationId: 'conv-1', messageId: 'msg-b', count: 2 }
    })
  );
  assert.equal(rolled.list.length, 1);
  assert.equal(rolled.unreadDelta, 0);
  assert.equal(rolled.list[0]!.body, '2 new messages · hello again');
  assert.equal(rolled.list[0]!.data?.messageId, 'msg-b');
  assert.equal(countUnreadNotifications(rolled.list), 1);
});

check('already-read realtime row does not bump unread', () => {
  const { unreadDelta } = ingestRealtimeNotification([], n('a', '2026-01-01T00:00:01Z', {
    readAt: '2026-01-01T00:00:02Z'
  }));
  assert.equal(unreadDelta, 0);
});

console.log('\n■ notifPreview privacy (body built at creation time)');

check('notifPreview=true keeps the normal text preview', () => {
  const body = buildNotificationBody({ kind: 'TEXT', text: 'secret party plans', notifPreview: true });
  assert.equal(body, 'secret party plans');
});

check('notifPreview=true previews long text to 120 chars', () => {
  const body = buildNotificationBody({ kind: 'TEXT', text: 'x'.repeat(200), notifPreview: true });
  assert.equal(body.length, 120);
});

check('notifPreview=false NEVER stores message text', () => {
  for (const text of ['secret party plans', 'password is hunter2', 'x'.repeat(200)]) {
    const body = buildNotificationBody({ kind: 'TEXT', text, notifPreview: false });
    assert.equal(body, 'New message');
    assert.ok(!body.includes('secret') && !body.includes('hunter2') && !body.includes('xxx'));
  }
});

check('notifPreview=false hides media kind text too (conservative)', () => {
  assert.equal(buildNotificationBody({ kind: 'IMAGE', text: 'caption leak?', notifPreview: false }), 'New message');
  assert.equal(buildNotificationBody({ kind: 'VIDEO', text: '', notifPreview: false }), 'New message');
});

check('notifPreview=true keeps existing media placeholders', () => {
  assert.equal(buildNotificationBody({ kind: 'IMAGE', text: '', notifPreview: true }), '📷 Photo');
  assert.equal(buildNotificationBody({ kind: 'VOICE', text: '', notifPreview: true }), '🎤 Voice message');
  assert.equal(mediaPlaceholder('DOCUMENT'), '📄 Document');
});

check('aggregated body strips text when previews are off', () => {
  const body = buildNotificationBody({ kind: 'TEXT', text: 'secret leak', notifPreview: false, count: 5 });
  assert.equal(body, '5 new messages');
});

check('aggregated body may include ONLY the latest preview when enabled', () => {
  const body = buildNotificationBody({ kind: 'TEXT', text: 'third one', notifPreview: true, count: 3 });
  assert.equal(body, '3 new messages · third one');
});

console.log('\n■ Aggregation rules (conservative)');

const recentRow = {
  type: 'MESSAGE',
  readAt: null,
  createdAt: new Date(1_000_000),
  data: buildNotificationData('conv-1', 'msg-1', 1)
};

check('fresh unread row for the same conversation aggregates', () => {
  assert.equal(
    shouldAggregate(recentRow, { conversationId: 'conv-1', now: 1_000_000 + 60_000 }),
    true
  );
});

check('READ rows never absorb new messages', () => {
  assert.equal(
    shouldAggregate({ ...recentRow, readAt: new Date(1_000_100) }, { conversationId: 'conv-1', now: 1_000_100 }),
    false
  );
});

check('different conversation never aggregates', () => {
  assert.equal(shouldAggregate(recentRow, { conversationId: 'conv-2', now: 1_000_000 }), false);
});

check('outside the burst window starts a new entry', () => {
  assert.equal(
    shouldAggregate(recentRow, {
      conversationId: 'conv-1',
      now: 1_000_000 + NOTIF_AGGREGATE_WINDOW_MS + 1
    }),
    false
  );
});

check('window boundary is inclusive of in-window rows', () => {
  assert.equal(
    shouldAggregate(recentRow, {
      conversationId: 'conv-1',
      now: 1_000_000 + NOTIF_AGGREGATE_WINDOW_MS
    }),
    true
  );
});

check('aggregate count capped — overflow starts a new entry', () => {
  const capped = {
    ...recentRow,
    data: buildNotificationData('conv-1', 'msg-9', NOTIF_AGGREGATE_MAX)
  };
  assert.equal(shouldAggregate(capped, { conversationId: 'conv-1', now: 1_000_000 }), false);
  const under = { ...recentRow, data: buildNotificationData('conv-1', 'msg-9', NOTIF_AGGREGATE_MAX - 1) };
  assert.equal(shouldAggregate(under, { conversationId: 'conv-1', now: 1_000_000 }), true);
});

check('non-MESSAGE rows and null never aggregate', () => {
  assert.equal(shouldAggregate({ ...recentRow, type: 'CALL' }, { conversationId: 'conv-1', now: 1_000_000 }), false);
  assert.equal(shouldAggregate(null, { conversationId: 'conv-1', now: 1_000_000 }), false);
});

check('aggregation data keeps navigation payload', () => {
  const data = parseNotificationData(buildNotificationData('conv-1', 'msg-2', 3));
  assert.deepEqual(data, { conversationId: 'conv-1', messageId: 'msg-2', count: 3 });
  const single = parseNotificationData(buildNotificationData('conv-1', 'msg-2', 1));
  assert.equal(single?.count, undefined);
});

check('corrupt data JSON parses to null (no crash, no aggregate)', () => {
  assert.equal(parseNotificationData('not-json{'), null);
  assert.equal(shouldAggregate({ ...recentRow, data: 'not-json{' }, { conversationId: 'conv-1', now: 1_000_000 }), false);
});

console.log('\n■ Deep links (internal routes only)');

check('message notification links to the message inside the conversation', () => {
  assert.equal(notificationDeepLink(n('a', '2026-01-01T00:00:01Z')), '/app/chats/conv-1?message=msg-a');
});

check('missing messageId falls back to the conversation', () => {
  const row = n('a', '2026-01-01T00:00:01Z', { data: { conversationId: 'conv-1' } });
  assert.equal(notificationDeepLink(row), '/app/chats/conv-1');
});

check('external URLs / javascript: / traversal never navigate', () => {
  // Unsafe CONVERSATION id → no link at all.
  const noLink: Array<Record<string, unknown>> = [
    { conversationId: 'javascript:alert(1)', messageId: 'x' },
    { conversationId: 'https://evil.com', messageId: 'x' },
    { conversationId: '//evil.com', messageId: 'x' },
    { conversationId: '../admin', messageId: 'x' },
    { conversationId: 'app/settings', messageId: 'x' }
  ];
  for (const data of noLink) {
    const link = notificationDeepLink({ ...(n('a', '2026-01-01T00:00:01Z')), data: data as NotificationDTO['data'] });
    assert.equal(link, null, `unsafe conversation id must not navigate: ${JSON.stringify(data)}`);
  }
  // Unsafe MESSAGE id with safe conversation → fall back to the conversation,
  // never embed the evil value.
  for (const data of [
    { conversationId: 'conv-1', messageId: 'https://evil.com' },
    { conversationId: 'conv-1', messageId: '../../etc' },
    { conversationId: 'conv-1', messageId: 'a b' }
  ]) {
    const link = notificationDeepLink({ ...(n('a', '2026-01-01T00:00:01Z')), data: data as NotificationDTO['data'] });
    assert.equal(link, '/app/chats/conv-1', `unsafe message id must fall back: ${JSON.stringify(data)}`);
  }
});

check('isSafeSegment allows cuid-like ids only', () => {
  assert.equal(isSafeSegment('cmukfbtcu00111339q237l9tj'), true);
  assert.equal(isSafeSegment('msg-a_1'), true);
  assert.equal(isSafeSegment(''), false);
  assert.equal(isSafeSegment('a/b'), false);
  assert.equal(isSafeSegment('a.b'), false);
  assert.equal(isSafeSegment(123), false);
  assert.equal(isSafeSegment(null), false);
});

console.log('\n■ Mark-read state flow (count stays in sync)');

check('ingest → mark read → count drops; refresh-order merge keeps readAt', () => {
  const step1 = ingestRealtimeNotification([], n('a', '2026-01-01T00:00:01Z'));
  const step2 = ingestRealtimeNotification(step1.list, n('b', '2026-01-01T00:00:02Z'));
  assert.equal(countUnreadNotifications(step2.list), 2);
  const marked = applyReadToNotifications(step2.list, ['a'], '2026-01-01T00:00:03Z');
  assert.equal(countUnreadNotifications(marked), 1);
  // server refresh replaces the list; readAt survives because it comes from the server copy
  const refreshed = mergeNotifications([], marked);
  assert.equal(countUnreadNotifications(refreshed), 1);
  assert.equal(refreshed.find((x) => x.id === 'a')?.readAt, '2026-01-01T00:00:03Z');
});

check('deep link opens the source conversation (message param included)', () => {
  assert.equal(notificationDeepLink(n('a', '2026-01-01T00:00:01Z')), '/app/chats/conv-1?message=msg-a');
});

check('notification without conversation data has no link', () => {
  const orphan = n('a', '2026-01-01T00:00:01Z', { data: null });
  assert.equal(notificationDeepLink(orphan), null);
});

check('per-conversation filter matches deep-link data', () => {
  const list = [
    n('a', '2026-01-01T00:00:01Z'),
    n('b', '2026-01-01T00:00:02Z', { data: { conversationId: 'conv-2' } })
  ];
  assert.equal(notificationsForConversation(list, 'conv-1').length, 1);
  assert.equal(notificationsForConversation(list, 'conv-2')[0]!.id, 'b');
  assert.equal(notificationsForConversation(list, 'conv-9').length, 0);
});

check('incoming and missed call copy stay distinct and contain no call content', () => {
  const incoming = buildIncomingCallNotification({ callerName: 'Ada', callKind: 'VIDEO', groupTitle: 'Family' });
  const missed = buildMissedCallNotification({ callerName: 'Ada', callKind: 'VIDEO', groupTitle: 'Family' });
  assert.equal(incoming.title, 'Incoming video call');
  assert.equal(incoming.body, 'Ada in Family');
  assert.equal(missed.title, 'Missed video call');
  assert.equal(missed.body, 'from Ada in Family');
  assert.equal(buildIncomingCallNotification({ callerName: 'Ada', callKind: 'VOICE' }).title, 'Incoming voice call');
});

console.log('\n════════════════════════════════════');
console.log(`PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
