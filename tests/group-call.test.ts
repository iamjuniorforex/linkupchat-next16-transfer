/**
 * Group-call state machine. No database, sockets, or media devices.
 * Covers membership planning, mesh cap, authorization of signals, missed
 * invites, host end, and bounded rejoin — not a fake media server.
 */

import assert from 'node:assert/strict';
import {
  MAX_MESH_PARTICIPANTS,
  acceptGroupCall,
  canExchangeSignal,
  declineGroupCall,
  expireGroupRejoin,
  expireGroupRing,
  getGroupCallForUser,
  groupHistoryStatus,
  isUserInGroupCall,
  leaveGroupCall,
  meshShouldOffer,
  planGroupInvites,
  resetGroupCallState,
  setGroupMediaState,
  startGroupCall
} from '../src/lib/group-call-state';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  resetGroupCallState();
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

console.log('\n● Group invite planning');

check('host must be a member, and outsiders cannot be invited', () => {
  assert.equal(planGroupInvites({ hostId: 'h', memberIds: ['a', 'b'] }).ok, false);
  const explicit = planGroupInvites({
    hostId: 'h',
    memberIds: ['h', 'a'],
    requestedIds: ['stranger']
  });
  assert.equal(explicit.ok, false);
  if (!explicit.ok) assert.equal(explicit.reason, 'NOT_ELIGIBLE');
});

check('groups larger than the mesh cap must pick people — nobody is silently dropped', () => {
  const auto = planGroupInvites({
    hostId: 'h',
    memberIds: ['h', 'a', 'b', 'c', 'd']
  });
  assert.equal(auto.ok, false);
  if (!auto.ok) assert.equal(auto.reason, 'MESH_LIMIT');
  const picked = planGroupInvites({
    hostId: 'h',
    memberIds: ['h', 'a', 'b', 'c', 'd'],
    requestedIds: ['a', 'c']
  });
  assert.equal(picked.ok, true);
  if (picked.ok) assert.deepEqual(picked.inviteeIds, ['a', 'c']);
});

check('blocked and busy people are not invited; an empty result is not a call', () => {
  const blocked = planGroupInvites({
    hostId: 'h',
    memberIds: ['h', 'a', 'b'],
    blockedIds: ['a'],
    busyIds: ['b']
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, 'NO_RECIPIENTS');
});

check('an explicit empty invite list does not call the whole group', () => {
  const res = planGroupInvites({
    hostId: 'h',
    memberIds: ['h', 'a'],
    requestedIds: []
  });
  assert.equal(res.ok, false);
});

console.log('\n● Group call lifecycle');

check('mesh cap is 4 and the lower user id offers', () => {
  assert.equal(MAX_MESH_PARTICIPANTS, 4);
  assert.equal(meshShouldOffer('a', 'b'), true);
  assert.equal(meshShouldOffer('b', 'a'), false);
});

check('start, accept, decline, and signal authorization', () => {
  const started = startGroupCall({
    callId: 'g1',
    conversationId: 'conv',
    hostId: 'h',
    inviteeIds: ['a', 'b'],
    type: 'VIDEO'
  });
  assert.equal(started.ok, true);
  assert.equal(isUserInGroupCall('a'), true);
  assert.equal(canExchangeSignal('g1', 'h', 'a'), false, 'invitee is not joined yet');

  const accepted = acceptGroupCall({ callId: 'g1', userId: 'a', socketId: 'sock-a' });
  assert.ok(accepted);
  assert.equal(accepted?.phase, 'CONNECTED');
  assert.ok(accepted?.connectedAt);
  assert.equal(canExchangeSignal('g1', 'h', 'a'), true);
  assert.equal(canExchangeSignal('g1', 'a', 'stranger'), false);
  assert.equal(canExchangeSignal('g1', 'x', 'a'), false);

  const declined = declineGroupCall({ callId: 'g1', userId: 'b' });
  assert.ok(declined);
  assert.equal(declined?.ended, null, 'one decline does not end a live call');
  assert.equal(isUserInGroupCall('b'), false);
  assert.equal(getGroupCallForUser('h')?.callId, 'g1');
});

check('a non-participant cannot accept, and a second accept is not a second join', () => {
  startGroupCall({ callId: 'g1', conversationId: 'conv', hostId: 'h', inviteeIds: ['a'], type: 'VOICE' });
  assert.equal(acceptGroupCall({ callId: 'g1', userId: 'stranger' }), null);
  assert.ok(acceptGroupCall({ callId: 'g1', userId: 'a', socketId: 'sock-1' }));
  const again = acceptGroupCall({ callId: 'g1', userId: 'a', socketId: 'sock-2' });
  assert.equal(again?.participants.filter((p) => p.userId === 'a').length, 1);
  assert.equal(again?.participants.find((p) => p.userId === 'a')?.socketId, 'sock-2');
});

check('host end notifies everyone; member leave does not', () => {
  startGroupCall({ callId: 'g1', conversationId: 'conv', hostId: 'h', inviteeIds: ['a', 'b'], type: 'VOICE' });
  acceptGroupCall({ callId: 'g1', userId: 'a' });
  const left = leaveGroupCall({ callId: 'g1', userId: 'a', via: 'user' });
  assert.equal(left?.ended, null);
  assert.equal(isUserInGroupCall('h'), true);
  const ended = leaveGroupCall({ callId: 'g1', userId: 'h', via: 'user' });
  assert.equal(ended?.ended?.status, 'ENDED');
  assert.ok(ended?.ended?.notifyUserIds.includes('b'));
  assert.equal(isUserInGroupCall('h'), false);
  assert.equal(canExchangeSignal('g1', 'h', 'a'), false);
});

check('ring timeout misses invitees and does not count as a connected duration', () => {
  startGroupCall({ callId: 'g1', conversationId: 'conv', hostId: 'h', inviteeIds: ['a'], type: 'VOICE' });
  const ended = expireGroupRing('g1');
  assert.equal(ended?.status, 'MISSED');
  assert.equal(ended?.durationSec, 0);
  assert.deepEqual(ended?.missedUserIds, ['a']);
  assert.equal(groupHistoryStatus('MISSED', 'MISSED'), 'MISSED');
  assert.equal(groupHistoryStatus('JOINED', 'ENDED'), 'ENDED');
  assert.equal(groupHistoryStatus('DECLINED', 'ENDED'), 'DECLINED');
});

check('socket drop can rejoin once; the grace then releases the slot', () => {
  startGroupCall({ callId: 'g1', conversationId: 'conv', hostId: 'h', inviteeIds: ['a', 'b'], type: 'VOICE' });
  acceptGroupCall({ callId: 'g1', userId: 'a' });
  acceptGroupCall({ callId: 'g1', userId: 'b' });
  const dropped = leaveGroupCall({ callId: 'g1', userId: 'a', via: 'disconnect' });
  assert.equal(dropped?.ended, null);
  assert.equal(isUserInGroupCall('a'), false);
  const rejoined = acceptGroupCall({ callId: 'g1', userId: 'a', socketId: 'sock-2' });
  assert.equal(rejoined?.participants.find((p) => p.userId === 'a')?.phase, 'JOINED');

  leaveGroupCall({ callId: 'g1', userId: 'a', via: 'disconnect' });
  const after = expireGroupRejoin('g1', 'a');
  assert.equal(after, null, 'b and host are still in the call');
  assert.equal(acceptGroupCall({ callId: 'g1', userId: 'a' }), null, 'grace expiry is final');
});

check('mute and camera state only change for a joined participant', () => {
  startGroupCall({ callId: 'g1', conversationId: 'conv', hostId: 'h', inviteeIds: ['a'], type: 'VIDEO' });
  assert.equal(setGroupMediaState({ callId: 'g1', userId: 'a', muted: true }), null);
  acceptGroupCall({ callId: 'g1', userId: 'a' });
  const updated = setGroupMediaState({ callId: 'g1', userId: 'a', muted: true, cameraOff: true });
  const row = updated?.participants.find((p) => p.userId === 'a');
  assert.equal(row?.muted, true);
  assert.equal(row?.cameraOff, true);
  assert.equal(setGroupMediaState({ callId: 'g1', userId: 'nope', muted: true }), null);
});

check('a retry while ringing does not create a second call', () => {
  const first = startGroupCall({
    callId: 'g1',
    conversationId: 'conv',
    hostId: 'h',
    inviteeIds: ['a'],
    type: 'VOICE'
  });
  const second = startGroupCall({
    callId: 'g2',
    conversationId: 'conv',
    hostId: 'h',
    inviteeIds: ['a'],
    type: 'VOICE'
  });
  assert.equal(first.ok && second.ok && second.deduped, true);
  if (second.ok) assert.equal(second.call.callId, 'g1');
});

console.log(`\n════════════════════════════════════\nPASSED ${passed}  FAILED ${failed}`);
if (failed > 0) process.exit(1);
