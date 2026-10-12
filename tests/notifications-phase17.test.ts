/**
 * Phase 17 — notification preference, mute, mention, sound, and badge policy.
 * Pure functions only. Run: npm run test:notifications:phase17
 */
import assert from 'node:assert/strict';
import {
  badgeCount,
  buildNotificationData,
  isConversationMuted,
  isMentioned,
  notificationAllowed,
  notificationDeepLink,
  parseNotificationData,
  shouldPlayNotificationSound
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
    console.error(err);
  }
}

const now = Date.parse('2026-10-11T12:00:00Z');

console.log('\n■ Preference and mute gate');

check('missing settings still allow delivery', () => {
  assert.equal(notificationAllowed({ channel: 'MESSAGE', settings: null }), true);
  assert.equal(notificationAllowed({ channel: 'STATUS', settings: undefined }), true);
});

check('master switch blocks every channel', () => {
  const settings = { notifEnabled: false, notifMessages: true, notifGroups: true, notifCalls: true, notifStatus: true };
  for (const channel of ['MESSAGE', 'GROUP_MESSAGE', 'REACTION', 'CALL', 'STATUS'] as const) {
    assert.equal(notificationAllowed({ channel, settings, mentioned: true }), false, channel);
  }
});

check('category toggles are independent', () => {
  assert.equal(notificationAllowed({ channel: 'MESSAGE', settings: { notifMessages: false, notifStatus: true } }), false);
  assert.equal(notificationAllowed({ channel: 'STATUS', settings: { notifMessages: false, notifStatus: true } }), true);
  assert.equal(notificationAllowed({ channel: 'CALL', settings: { notifCalls: false, notifMessages: true } }), false);
  assert.equal(notificationAllowed({ channel: 'GROUP_MESSAGE', settings: { notifGroups: false } }), false);
});

check('mute blocks messages unless a group mention bypasses it', () => {
  const mutedUntil = new Date(now + 60_000);
  assert.equal(notificationAllowed({ channel: 'MESSAGE', mutedUntil, now }), false);
  assert.equal(notificationAllowed({ channel: 'GROUP_MESSAGE', mutedUntil, now }), false);
  assert.equal(notificationAllowed({ channel: 'GROUP_MESSAGE', mutedUntil, mentioned: true, now }), true);
  assert.equal(
    notificationAllowed({
      channel: 'GROUP_MESSAGE',
      settings: { notifGroups: false },
      mutedUntil,
      mentioned: true,
      now
    }),
    false
  );
});

check('expired mute does not block', () => {
  assert.equal(isConversationMuted(new Date(now - 1), now), false);
  assert.equal(isConversationMuted('not-a-date', now), false);
  assert.equal(notificationAllowed({ channel: 'MESSAGE', mutedUntil: new Date(now - 1), now }), true);
});

console.log('\n■ Mentions');

check('mention matches a bounded @username only', () => {
  assert.equal(isMentioned('hey @ada check this', 'ada'), true);
  assert.equal(isMentioned('@ada', 'ada'), true);
  assert.equal(isMentioned('email ada@ada.com', 'ada'), false);
  assert.equal(isMentioned('hey @adam', 'ada'), false);
  assert.equal(isMentioned('hey @Ada', 'ada'), true);
  assert.equal(isMentioned('hey @ada', 'not a name'), false);
});

check('mention flag is stored without message text', () => {
  const raw = buildNotificationData('conv1', 'msg1', 2, { mention: true });
  const data = parseNotificationData(raw);
  assert.equal(data?.mention, true);
  assert.equal(data?.count, 2);
  assert.equal(raw.includes('secret'), false);
});

console.log('\n■ Sound and badge');

check('sound respects mute, hidden tab, call ring, and overlap', () => {
  const base = {
    soundsEnabled: true,
    isNew: true,
    documentHidden: false,
    callSoundActive: false,
    lastPlayedAt: null,
    now: 10_000
  };
  assert.equal(shouldPlayNotificationSound(base), true);
  assert.equal(shouldPlayNotificationSound({ ...base, soundsEnabled: false }), false);
  assert.equal(shouldPlayNotificationSound({ ...base, isNew: false }), false);
  assert.equal(shouldPlayNotificationSound({ ...base, documentHidden: true }), false);
  assert.equal(shouldPlayNotificationSound({ ...base, callSoundActive: true }), false);
  assert.equal(shouldPlayNotificationSound({ ...base, lastPlayedAt: 9_000, now: 10_000 }), false);
  assert.equal(shouldPlayNotificationSound({ ...base, lastPlayedAt: 8_000, now: 10_000 }), true);
});

check('badge clamps to 0..99', () => {
  assert.equal(badgeCount(0), 0);
  assert.equal(badgeCount(-3), 0);
  assert.equal(badgeCount(4.8), 4);
  assert.equal(badgeCount(120), 99);
  assert.equal(badgeCount(Number.NaN), 0);
});

console.log('\n■ Deep links');

function row(partial: Partial<NotificationDTO>): NotificationDTO {
  return {
    id: 'n1',
    type: 'SYSTEM',
    title: 't',
    body: null,
    data: null,
    readAt: null,
    createdAt: '2026-10-11T00:00:00Z',
    ...partial
  };
}

check('status and call rows navigate internally', () => {
  assert.equal(
    notificationDeepLink(row({ data: { kind: 'status-update', userId: 'u1' } })),
    '/app/status'
  );
  assert.equal(notificationDeepLink(row({ type: 'CALL', data: { callId: 'call_1' } })), '/app/calls');
  assert.equal(notificationDeepLink(row({ type: 'SYSTEM', data: null })), null);
});

check('unsafe status payload does not leave the app', () => {
  const link = notificationDeepLink(row({ data: { kind: 'status-update', url: 'https://evil.example' } }));
  assert.equal(link, '/app/status');
  assert.equal(link?.includes('evil'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
