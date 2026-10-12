/**
 * Phase 1 — unread math unit tests (global total, realtime bump, read-up-to,
 * badge caps, list filter).
 *
 * Run: npm run test:unread   (tsx tests/unread.test.ts)
 */
import assert from 'node:assert/strict';
import {
  UNREAD_BADGE_CAP,
  bumpUnreadOnIncoming,
  firstUnreadMessageId,
  formatUnreadBadge,
  passesUnreadFilter,
  remainingUnreadAfterRead,
  sumUnread
} from '../src/lib/unread';
import type { ConversationDTO, MessageDTO } from '../src/types';

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

function msg(id: string, createdAt: string, opts: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id,
    conversationId: 'c1',
    senderId: 'other',
    sender: null,
    type: 'TEXT',
    content: 'x',
    clientNonce: null,
    replyToId: null,
    replyTo: null,
    attachments: [],
    reactions: [],
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    createdAt,
    updatedAt: createdAt,
    status: 'SENT',
    readBy: [],
    isMine: false,
    ...opts
  } as MessageDTO;
}

console.log('\n■ Badge formatting (99+ cap)');

check('zero and negative counts show no badge', () => {
  assert.equal(formatUnreadBadge(0), null);
  assert.equal(formatUnreadBadge(-3), null);
});

check('counts 1..99 show verbatim', () => {
  assert.equal(formatUnreadBadge(1), '1');
  assert.equal(formatUnreadBadge(42), '42');
  assert.equal(formatUnreadBadge(UNREAD_BADGE_CAP), '99');
});

check('counts above the cap show 99+', () => {
  assert.equal(formatUnreadBadge(100), '99+');
  assert.equal(formatUnreadBadge(5000), '99+');
});

console.log('\n■ Global unread total');

check('sums unread across 1:1 and group conversations', () => {
  const convs = [{ unreadCount: 3 }, { unreadCount: 2 }, { unreadCount: 0 }] as ConversationDTO[];
  assert.equal(sumUnread(convs), 5);
});

check('treats missing/negative counts as zero', () => {
  const convs = [{ unreadCount: undefined }, { unreadCount: -4 }, { unreadCount: 1 }] as unknown as ConversationDTO[];
  assert.equal(sumUnread(convs), 1);
});

check('empty conversation list totals zero', () => {
  assert.equal(sumUnread([]), 0);
});

console.log('\n■ Realtime increment (MESSAGE_NEW)');

check('another member message increments the conversation', () => {
  assert.equal(bumpUnreadOnIncoming(4, msg('m1', '2026-01-01T00:00:05Z')), 5);
});

check('my own message never increments (sender exclusion)', () => {
  assert.equal(bumpUnreadOnIncoming(4, msg('m1', '2026-01-01T00:00:05Z', { isMine: true })), 4);
});

check('deleted messages never increment', () => {
  assert.equal(
    bumpUnreadOnIncoming(4, msg('m1', '2026-01-01T00:00:05Z', { deletedAt: '2026-01-01T00:00:06Z' })),
    4
  );
});

check('increments even when the chat is open-but-scrolled-up or tab-hidden', () => {
  // Visibility corrections happen via markRead (remainingUnreadAfterRead) —
  // the bump itself must stay honest for messages the user has not seen.
  assert.equal(bumpUnreadOnIncoming(0, msg('m1', '2026-01-01T00:00:05Z')), 1);
});

console.log('\n■ Read-up-to-message (mark-read decrement)');

const list = [
  msg('m1', '2026-01-01T00:00:01Z'),
  msg('m2', '2026-01-01T00:00:02Z'),
  msg('m3', '2026-01-01T00:00:03Z'),
  msg('mine', '2026-01-01T00:00:04Z', { isMine: true }),
  msg('m4', '2026-01-01T00:00:05Z'),
  msg('m5', '2026-01-01T00:00:06Z', { deletedAt: '2026-01-01T00:00:07Z' })
];

check('reading up to a message leaves only later unread', () => {
  // Up to m2 → remaining: m3, m4 (m5 deleted, "mine" excluded) = 2
  assert.equal(remainingUnreadAfterRead(list, 'm2'), 2);
});

check('reading up to the newest message clears everything', () => {
  assert.equal(remainingUnreadAfterRead(list, 'm4'), 0);
  assert.equal(remainingUnreadAfterRead(list, 'm5'), 0);
});

check('no messageId (mark-all fallback) clears everything', () => {
  assert.equal(remainingUnreadAfterRead(list, undefined), 0);
});

check('unknown messageId is a safe no-op clear', () => {
  assert.equal(remainingUnreadAfterRead(list, 'nope'), 0);
});

check('deleted messages do not count as unread', () => {
  const base = [msg('a', '2026-01-01T00:00:01Z'), msg('b', '2026-01-01T00:00:02Z')];
  base[1]!.deletedAt = '2026-01-01T00:00:03Z';
  assert.equal(remainingUnreadAfterRead(base, 'a'), 0);
});

console.log('\n■ Unread list filter');

check('All keeps every conversation', () => {
  assert.equal(passesUnreadFilter({ unreadCount: 0 }, 'all'), true);
  assert.equal(passesUnreadFilter({ unreadCount: 3 }, 'all'), true);
});

check('Unread keeps only conversations with unreadCount > 0', () => {
  assert.equal(passesUnreadFilter({ unreadCount: 3 }, 'unread'), true);
  assert.equal(passesUnreadFilter({ unreadCount: 0 }, 'unread'), false);
  assert.equal(
    passesUnreadFilter({ unreadCount: undefined } as unknown as ConversationDTO, 'unread'),
    false
  );
});

console.log('\n■ Unread-message separator anchor');

const tmsg = (id: string, isMine: boolean, deletedAt: string | null = null) => ({
  id,
  isMine,
  deletedAt
});

check('anchors before the first message of the unread tail', () => {
  const list = [tmsg('m1', true), tmsg('m2', false), tmsg('m3', false), tmsg('m4', false)];
  assert.equal(firstUnreadMessageId(list, 2), 'm3');
});

check('skips own and deleted messages when counting the unread tail', () => {
  const list = [tmsg('m1', true), tmsg('m2', false), tmsg('m3', false, 'deleted'), tmsg('m4', true), tmsg('m5', false)];
  assert.equal(firstUnreadMessageId(list, 2), 'm2');
});

check('returns null when nothing is unread or the list is empty', () => {
  assert.equal(firstUnreadMessageId([tmsg('m1', true), tmsg('m2', true)], 2), null);
  assert.equal(firstUnreadMessageId([tmsg('m1', false)], 0), null);
  assert.equal(firstUnreadMessageId([], 3), null);
});

check('unread tail past the loaded window anchors to the earliest incoming message', () => {
  const list = [tmsg('m1', true), tmsg('m2', false), tmsg('m3', true), tmsg('m4', false)];
  assert.equal(firstUnreadMessageId(list, 10), 'm2');
});

console.log('\n════════════════════════════════════');
console.log(`PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
