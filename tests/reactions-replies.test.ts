/**
 * Phase 3 — reactions + replies unit tests (pure shared semantics).
 *
 * Covers: one-reaction-per-user replace/remove math, reply preview labels for
 * every message type incl. deleted, and the reaction emoji whitelist.
 *
 * Run: npm run test:reactions   (tsx tests/reactions-replies.test.ts)
 */
import assert from 'node:assert/strict';
import {
  EMOJI_REACTIONS,
  applyReactionToggle,
  formatReplyPreview,
  isSupportedReaction,
  type ReactionEntry
} from '../src/lib/utils';
import {
  buildReactionNotification,
  buildReactionNotificationData,
  latestUnreadReactionEmoji,
  parseNotificationData
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

const ME = 'user-me';
const YOU = 'user-you';

function entry(emoji: string, userIds: string[], me = ME): ReactionEntry {
  return {
    emoji,
    count: userIds.length,
    userIds,
    reacted: userIds.includes(me)
  };
}

console.log('\n■ Supported reaction emojis (spec set)');

check('exactly the six spec emojis, in spec order', () => {
  assert.deepEqual([...EMOJI_REACTIONS], ['❤️', '👍', '😂', '😮', '😢', '🙏']);
});

check('all six are accepted', () => {
  for (const e of ['❤️', '👍', '😂', '😮', '😢', '🙏']) {
    assert.equal(isSupportedReaction(e), true, `${e} must be supported`);
  }
});

check('anything else is rejected (incl. the old 😡)', () => {
  for (const e of ['😡', '🦄', '👍🏽', '', 'a'.repeat(9), 42, null, undefined]) {
    assert.equal(isSupportedReaction(e), false, `${String(e)} must be rejected`);
  }
});

console.log('\n■ One reaction per user — replace / remove semantics');

check('first reaction adds with count 1', () => {
  const next = applyReactionToggle([], ME, '👍');
  assert.deepEqual(next, [{ emoji: '👍', count: 1, userIds: [ME], reacted: true }]);
});

check('selecting the SAME emoji removes the reaction', () => {
  const next = applyReactionToggle([entry('👍', [ME])], ME, '👍');
  assert.deepEqual(next, []);
});

check('selecting ANOTHER emoji REPLACES (never two rows for one user)', () => {
  const next = applyReactionToggle([entry('👍', [ME, YOU])], ME, '😂');
  assert.equal(next.length, 2, `expected 2 emoji groups, got ${next.length}`);
  const thumbs = next.find((r) => r.emoji === '👍')!;
  const joy = next.find((r) => r.emoji === '😂')!;
  assert.equal(thumbs.count, 1);
  assert.deepEqual(thumbs.userIds, [YOU]);
  assert.equal(thumbs.reacted, false);
  assert.equal(joy.count, 1);
  assert.deepEqual(joy.userIds, [ME]);
  assert.equal(joy.reacted, true);
  const myRows = next.filter((r) => r.userIds.includes(ME));
  assert.equal(myRows.length, 1, 'user must appear in exactly one group');
});

check('replacing into an existing group increments that group', () => {
  const next = applyReactionToggle([entry('👍', [ME]), entry('😂', [YOU])], ME, '😂');
  const joy = next.find((r) => r.emoji === '😂')!;
  assert.equal(joy.count, 2);
  assert.deepEqual(joy.userIds, [YOU, ME]);
  assert.equal(joy.reacted, true);
  assert.equal(next.find((r) => r.emoji === '👍'), undefined);
});

check('removing from a multi-user group keeps the others', () => {
  const next = applyReactionToggle([entry('❤️', [ME, YOU])], ME, '❤️');
  assert.deepEqual(next, [{ emoji: '❤️', count: 1, userIds: [YOU], reacted: false }]);
});

check('view-only (no me id) is a no-op', () => {
  const before = [entry('👍', [YOU])];
  assert.equal(applyReactionToggle(before, undefined, '👍'), before);
});

check('does not mutate the input array', () => {
  const before = [entry('👍', [ME])];
  applyReactionToggle(before, ME, '😂');
  assert.equal(before.length, 1);
  assert.equal(before[0]!.emoji, '👍');
});

console.log('\n■ Reply previews (all types + deleted)');

check('text replies show the text', () => {
  assert.equal(formatReplyPreview({ type: 'TEXT', content: 'See you tomorrow' }), 'See you tomorrow');
});

check('sticker replies show the sticker', () => {
  assert.equal(formatReplyPreview({ type: 'STICKER', content: '🎉' }), '🎉');
});

check('media types get appropriate labels (never invalid content)', () => {
  const cases: Array<[string, string]> = [
    ['IMAGE', '📷 Photo'],
    ['VIDEO', '🎥 Video'],
    ['VOICE', '🎤 Voice message'],
    ['AUDIO', '🎵 Audio'],
    ['DOCUMENT', '📄 Document'],
    ['GIF', 'GIF'],
    ['STICKER', 'Sticker']
  ];
  for (const [type, label] of cases) {
    assert.equal(formatReplyPreview({ type, content: null }), label, type);
    assert.equal(formatReplyPreview({ type, content: '' }), label, `${type} (empty content)`);
  }
});

check('deleted messages never leak old content', () => {
  const preview = formatReplyPreview({ type: 'TEXT', content: 'secret text', deletedAt: '2026-01-01T00:00:00Z' });
  assert.equal(preview, 'This message was deleted');
  assert.ok(!preview.includes('secret'));
  // quote DTO variant: deletedAt as boolean
  assert.equal(
    formatReplyPreview({ type: 'IMAGE', content: 'old caption', deletedAt: true }),
    'This message was deleted'
  );
});

check('unknown/missing messages degrade gracefully', () => {
  assert.equal(formatReplyPreview(null), 'Message');
  assert.equal(formatReplyPreview(undefined), 'Message');
  assert.equal(formatReplyPreview({ type: 'SYSTEM', content: null }), 'Attachment');
  assert.equal(formatReplyPreview({ type: 'SYSTEM', content: 'hi' }), 'hi');
});

console.log('\n■ Reaction notifications (away recipients)');

check('direct: "John reacted ❤️ to your message" split across title/body', () => {
  const { title, body } = buildReactionNotification({
    reactorName: 'John',
    emoji: '❤️',
    notifPreview: false,
    messageText: 'secret text',
    messageKind: 'TEXT'
  });
  assert.equal(title, 'John reacted ❤️');
  assert.equal(body, 'to your message');
  assert.ok(!`${title} ${body}`.includes('secret'), 'message text leaked with previews off');
});

check('group: appends " in Family"', () => {
  const { body } = buildReactionNotification({
    reactorName: 'John',
    emoji: '👍',
    groupTitle: 'Family',
    notifPreview: false,
    messageText: 'secret',
    messageKind: 'TEXT'
  });
  assert.equal(body, 'to your message in Family');
});

check('notifPreview=true may include the message preview', () => {
  const { body } = buildReactionNotification({
    reactorName: 'John',
    emoji: '😂',
    notifPreview: true,
    messageText: 'See you tomorrow',
    messageKind: 'TEXT'
  });
  assert.equal(body, 'to your message: See you tomorrow');
});

check('notifPreview=true media previews use type labels', () => {
  const { body } = buildReactionNotification({
    reactorName: 'John',
    emoji: '😮',
    notifPreview: true,
    messageText: null,
    messageKind: 'IMAGE'
  });
  assert.equal(body, 'to your message: 📷 Photo');
});

check('notifPreview=false hides media previews too', () => {
  const { body } = buildReactionNotification({
    reactorName: 'John',
    emoji: '😮',
    notifPreview: false,
    messageText: null,
    messageKind: 'IMAGE'
  });
  assert.equal(body, 'to your message');
});

check('reaction data keeps deep-link + identity fields', () => {
  const data = parseNotificationData(
    buildReactionNotificationData('conv-1', 'msg-1', 'user-a', '❤️')
  );
  assert.deepEqual(data, {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    reactorId: 'user-a',
    emoji: '❤️'
  });
});

function notif(partial: Partial<NotificationDTO>): NotificationDTO {
  return {
    id: partial.id ?? 'n1',
    type: partial.type ?? 'REACTION',
    title: partial.title ?? 'x',
    body: partial.body ?? null,
    data: partial.data ?? null,
    readAt: partial.readAt ?? null,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:01Z'
  };
}

check('chats-list chip: newest unread REACTION emoji per conversation', () => {
  const list = [
    notif({ id: 'a', data: { conversationId: 'conv-1', emoji: '👍' }, createdAt: '2026-01-01T00:00:02Z' }),
    notif({ id: 'b', data: { conversationId: 'conv-1', emoji: '😂' }, createdAt: '2026-01-01T00:00:01Z' })
  ];
  assert.equal(latestUnreadReactionEmoji(list, 'conv-1'), '👍');
  assert.equal(latestUnreadReactionEmoji(list, 'conv-2'), null);
});

check('chats-list chip ignores read rows and MESSAGE rows', () => {
  const list = [
    notif({ id: 'a', type: 'REACTION', readAt: '2026-01-01T00:00:03Z', data: { conversationId: 'conv-1', emoji: '👍' } }),
    notif({ id: 'b', type: 'MESSAGE', data: { conversationId: 'conv-1', emoji: '😂' } })
  ];
  assert.equal(latestUnreadReactionEmoji(list, 'conv-1'), null);
});

check('chats-list chip falls back to a heart when the emoji is missing', () => {
  const list = [notif({ id: 'a', data: { conversationId: 'conv-1' } })];
  assert.equal(latestUnreadReactionEmoji(list, 'conv-1'), '❤️');
});

console.log('\n════════════════════════════════════');
console.log(`PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
