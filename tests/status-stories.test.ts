/**
 * Phase 15 — status audience, archive, reactions, and reply attribution.
 * Pure tests: no database, no browser.
 */
import assert from 'node:assert/strict';
import {
  audienceAllows,
  validateAudienceSelection,
  isActiveStatus,
  isArchivedStatus,
  statusReplyContent,
  nextReaction,
  splitStatusGroups,
  buildStatusReactionNotice,
  buildStatusReplyNotice,
  buildStatusUpdateNotice,
  storyDurationMs,
  isStatusEmoji
} from '../src/lib/status-stories';

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
    console.log(`    ${(err as Error).message}`);
  }
}

const now = new Date('2026-10-11T12:00:00.000Z');
const future = new Date('2026-10-12T12:00:00.000Z');
const past = new Date('2026-10-10T12:00:00.000Z');

check('default contacts audience adds no extra restriction', () => {
  assert.equal(
    audienceAllows({ viewerId: 'v', authorId: 'a', audience: 'CONTACTS', memberIds: ['x'] }),
    true
  );
  assert.equal(audienceAllows({ viewerId: 'a', authorId: 'a', audience: 'ONLY_SHARE', memberIds: [] }), true);
});

check('contacts-except hides only the listed people', () => {
  assert.equal(
    audienceAllows({ viewerId: 'skip', authorId: 'a', audience: 'CONTACTS_EXCEPT', memberIds: ['skip'] }),
    false
  );
  assert.equal(
    audienceAllows({ viewerId: 'ok', authorId: 'a', audience: 'CONTACTS_EXCEPT', memberIds: ['skip'] }),
    true
  );
});

check('only-share shows listed people and nobody else', () => {
  assert.equal(
    audienceAllows({ viewerId: 'pal', authorId: 'a', audience: 'ONLY_SHARE', memberIds: ['pal'] }),
    true
  );
  assert.equal(
    audienceAllows({ viewerId: 'stranger', authorId: 'a', audience: 'ONLY_SHARE', memberIds: ['pal'] }),
    false
  );
});

check('audience lists must be the author contacts, and empty lists are rejected', () => {
  const empty = validateAudienceSelection({
    audience: 'ONLY_SHARE',
    memberIds: [],
    authorId: 'a',
    contactIds: ['b']
  });
  assert.equal(empty.ok, false);
  const outsider = validateAudienceSelection({
    audience: 'CONTACTS_EXCEPT',
    memberIds: ['stranger'],
    authorId: 'a',
    contactIds: ['b']
  });
  assert.equal(outsider.ok, false);
  const ok = validateAudienceSelection({
    audience: 'ONLY_SHARE',
    memberIds: ['b', 'b', 'a'],
    authorId: 'a',
    contactIds: ['b']
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.memberIds, ['b']);
});

check('active feeds exclude expired, archived, and deleted statuses', () => {
  assert.equal(isActiveStatus({ expiresAt: future }, now), true);
  assert.equal(isActiveStatus({ expiresAt: past }, now), false);
  assert.equal(isActiveStatus({ expiresAt: future, archivedAt: now }, now), false);
  assert.equal(isActiveStatus({ expiresAt: future, deletedAt: now }, now), false);
});

check('archive keeps expired and archived rows, never deleted ones', () => {
  assert.equal(isArchivedStatus({ expiresAt: past }, now), true);
  assert.equal(isArchivedStatus({ expiresAt: future, archivedAt: now }, now), true);
  assert.equal(isArchivedStatus({ expiresAt: future }, now), false);
  assert.equal(isArchivedStatus({ expiresAt: past, deletedAt: now }, now), false);
});

check('a reaction is unique per viewer: same emoji clears, a new emoji replaces', () => {
  assert.equal(nextReaction(null, '❤️'), '❤️');
  assert.equal(nextReaction('❤️', '❤️'), null);
  assert.equal(nextReaction('❤️', '🔥'), '🔥');
  assert.equal(nextReaction('❤️', 'nope'), '❤️');
  assert.equal(isStatusEmoji('😂'), true);
});

check('replies attribute the original status and do not include a second copy of the reply', () => {
  const text = statusReplyContent({ reply: 'Nice shot', statusType: 'IMAGE', statusText: 'Sunset' });
  assert.match(text, /photo status/);
  assert.match(text, /Sunset/);
  assert.match(text, /Nice shot/);
  assert.equal(text.split('Nice shot').length, 2);
  const hidden = buildStatusReplyNotice({ senderName: 'Ada', notifPreview: false, replyText: 'secret words' });
  assert.equal(hidden.body.includes('secret'), false);
  const shown = buildStatusReactionNotice({
    reactorName: 'Ada',
    emoji: '🔥',
    notifPreview: false,
    statusText: 'private caption'
  });
  assert.equal(shown.body.includes('private'), false);
});

check('status-update notices aggregate instead of repeating the same line', () => {
  assert.equal(buildStatusUpdateNotice({ authorName: 'Ada', count: 1 }).body, 'posted a new status');
  assert.match(buildStatusUpdateNotice({ authorName: 'Ada', count: 3 }).body, /3/);
});

check('viewed updates are separated from recent ones', () => {
  const split = splitStatusGroups([
    { id: 'new', statuses: [{ viewedByMe: false }] },
    { id: 'old', statuses: [{ viewedByMe: true }] }
  ]);
  assert.deepEqual(split.recent.map((g) => g.id), ['new']);
  assert.deepEqual(split.viewed.map((g) => g.id), ['old']);
});

check('video stories use the clip length, capped, and photos stay short', () => {
  assert.equal(storyDurationMs('TEXT'), 5000);
  assert.equal(storyDurationMs('VIDEO', 2000), 4000);
  assert.equal(storyDurationMs('VIDEO', 120_000), 30000);
});

console.log(`\nPASSED ${passed}  FAILED ${failed}`);
if (failed) process.exit(1);
