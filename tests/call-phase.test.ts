/**
 * Phase 14 Step 1 — focused tests for the centralized call state machine and
 * call-overlay decision helpers (pure — no DOM, no media devices, no server).
 *
 * Covers the spec's targeted areas: incoming/outgoing call states, call state
 * transitions (including reconnecting/ended), duration start semantics,
 * permission-error copy, and camera-switch support rules. Media tracks,
 * accept/decline signaling, and cleanup are covered by the existing
 * call-engine / calls / calls:e2e / browser suites.
 */

import assert from 'node:assert/strict';
import {
  deriveCallPhase,
  describeCallStatus,
  mediaIssueMessage,
  connectedElapsedSeconds,
  switchableCameraDeviceIds,
  pickNextCameraDeviceId,
  obviousCallState,
  obviousStateLabel,
  classifyCallTerminal,
  rememberConcludedId,
  controlsFromMedia,
  speakerOutputSupported,
  shouldInitiateIceRestart,
  signalAppliesToActiveCall,
  localIceSignalCallId,
  pendingOutgoingEventApplies,
  summarizeCallStats,
  deriveNetworkQuality,
  networkQualityLabel,
  clampPreviewPosition
} from '../src/lib/call-phase';

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
    console.log(`    ${(err as Error).message.split('\n')[0]}`);
  }
}

console.log('\n● Call phase derivation (state machine)');

check('idle when no call exists', () => {
  assert.equal(deriveCallPhase({ direction: null, callState: null }), 'idle');
});

check('incoming state while an inbound call is ringing', () => {
  assert.equal(deriveCallPhase({ direction: 'INCOMING', callState: 'RINGING' }), 'incoming');
});

check('outgoing state while an outbound call is ringing', () => {
  assert.equal(deriveCallPhase({ direction: 'OUTGOING', callState: 'RINGING' }), 'outgoing');
});

check('connecting state after accept / while negotiating', () => {
  assert.equal(deriveCallPhase({ direction: 'INCOMING', callState: 'CONNECTING' }), 'connecting');
  assert.equal(deriveCallPhase({ direction: 'OUTGOING', callState: 'CONNECTING' }), 'connecting');
});

check('connected state once media flows', () => {
  assert.equal(deriveCallPhase({ direction: 'OUTGOING', callState: 'CONNECTED' }), 'connected');
});

check('reconnecting only while connected', () => {
  assert.equal(
    deriveCallPhase({ direction: 'OUTGOING', callState: 'CONNECTED', reconnecting: true }),
    'reconnecting'
  );
});

check('drop while still connecting does not claim reconnecting', () => {
  assert.equal(
    deriveCallPhase({ direction: 'INCOMING', callState: 'CONNECTING', reconnecting: true }),
    'connecting'
  );
  assert.equal(
    deriveCallPhase({ direction: 'INCOMING', callState: 'RINGING', reconnecting: true }),
    'incoming'
  );
});

check('declined/ended calls map to ended (concluded)', () => {
  assert.equal(
    deriveCallPhase({ direction: 'INCOMING', callState: 'RINGING', concluded: true }),
    'ended'
  );
});

check('a permission/media issue is a terminal ended state', () => {
  assert.equal(
    deriveCallPhase({ direction: 'OUTGOING', callState: 'RINGING', issue: true }),
    'ended'
  );
});

console.log('\n● Call status line (incl. connected-duration contract)');

check('connected voice/video keep the tested "call · m:ss" shape', () => {
  const voice = describeCallStatus({
    direction: 'OUTGOING',
    callState: 'CONNECTED',
    type: 'VOICE',
    elapsedSec: 5
  });
  assert.equal(voice, 'Voice call · 0:05');
  assert.match(voice, /call · /);
  const video = describeCallStatus({
    direction: 'INCOMING',
    callState: 'CONNECTED',
    type: 'VIDEO',
    elapsedSec: 300
  });
  assert.equal(video, 'Video call · 5:00');
  assert.match(video, /call · /);
});

check('incoming ringing states name the call type', () => {
  assert.equal(
    describeCallStatus({ direction: 'INCOMING', callState: 'RINGING', type: 'VOICE', elapsedSec: 0 }),
    'Incoming voice call…'
  );
  assert.equal(
    describeCallStatus({ direction: 'INCOMING', callState: 'RINGING', type: 'VIDEO', elapsedSec: 0 }),
    'Incoming video call…'
  );
});

check('outgoing distinguishes Calling… from Ringing…', () => {
  assert.equal(
    describeCallStatus({
      direction: 'OUTGOING',
      callState: 'RINGING',
      type: 'VIDEO',
      elapsedSec: 0,
      callingOnly: true
    }),
    'Calling…'
  );
  assert.equal(
    describeCallStatus({
      direction: 'OUTGOING',
      callState: 'RINGING',
      type: 'VIDEO',
      elapsedSec: 0,
      callingOnly: false
    }),
    'Ringing…'
  );
});

check('connecting and reconnecting are surfaced', () => {
  assert.equal(
    describeCallStatus({ direction: 'OUTGOING', callState: 'CONNECTING', type: 'VOICE', elapsedSec: 0 }),
    'Connecting…'
  );
  assert.equal(
    describeCallStatus({
      direction: 'OUTGOING',
      callState: 'CONNECTED',
      type: 'VOICE',
      elapsedSec: 12,
      reconnecting: true
    }),
    'Reconnecting…'
  );
});

check('issue labels distinguish voice from video', () => {
  assert.equal(
    describeCallStatus({
      direction: 'OUTGOING',
      callState: 'RINGING',
      type: 'VOICE',
      elapsedSec: 0,
      issue: 'PERMISSION_DENIED'
    }),
    'Microphone permission needed'
  );
  assert.equal(
    describeCallStatus({
      direction: 'OUTGOING',
      callState: 'RINGING',
      type: 'VIDEO',
      elapsedSec: 0,
      issue: 'PERMISSION_DENIED'
    }),
    'Camera and microphone permission needed'
  );
  assert.equal(
    describeCallStatus({
      direction: 'OUTGOING',
      callState: 'RINGING',
      type: 'VIDEO',
      elapsedSec: 0,
      issue: 'MEDIA_ERROR'
    }),
    'Camera or microphone unavailable'
  );
});

console.log('\n● Permission / media error copy');

check('video permission failures require camera AND microphone', () => {
  const out = mediaIssueMessage('PERMISSION_DENIED', 'VIDEO', 'OUTGOING');
  assert.match(out, /camera and microphone/i);
  assert.match(out, /place/);
  const inc = mediaIssueMessage('PERMISSION_DENIED', 'VIDEO', 'INCOMING');
  assert.match(inc, /camera and microphone/i);
  assert.match(inc, /answer/);
});

check('voice permission failures mention the microphone only', () => {
  const msg = mediaIssueMessage('PERMISSION_DENIED', 'VOICE', 'OUTGOING');
  assert.match(msg, /microphone/i);
  assert.doesNotMatch(msg, /camera/i);
});

check('raw browser error names never leak into user copy', () => {
  for (const issue of ['PERMISSION_DENIED', 'MEDIA_ERROR'] as const) {
    for (const type of ['VOICE', 'VIDEO'] as const) {
      for (const dir of ['INCOMING', 'OUTGOING'] as const) {
        const msg = mediaIssueMessage(issue, type, dir);
        assert.doesNotMatch(msg, /NotAllowedError|NotFoundError|NotReadableError|OverconstrainedError|TypeError|DOMException/);
        assert.notEqual(msg, '');
      }
    }
  }
});

console.log('\n● Camera switching support rules');

check('device list keeps only real video inputs', () => {
  const ids = switchableCameraDeviceIds([
    { kind: 'audioinput', deviceId: 'mic' },
    { kind: 'videoinput', deviceId: 'cam-front' },
    { kind: 'videoinput', deviceId: '' },
    { kind: 'videoinput', deviceId: 'cam-back' }
  ]);
  assert.deepEqual(ids, ['cam-front', 'cam-back']);
});

check('rotation cycles through cameras and wraps', () => {
  const ids = ['front', 'back'];
  assert.equal(pickNextCameraDeviceId('front', ids), 'back');
  assert.equal(pickNextCameraDeviceId('back', ids), 'front');
  assert.equal(pickNextCameraDeviceId(null, ids), 'front');
  assert.equal(pickNextCameraDeviceId('unknown', ids), 'front');
});

check('switching is unsupported with fewer than two cameras', () => {
  assert.equal(pickNextCameraDeviceId('only', ['only']), null);
  assert.equal(pickNextCameraDeviceId('x', []), null);
});

console.log('\n● Duration start semantics');

check('duration is 0 until the call connects', () => {
  assert.equal(connectedElapsedSeconds(0, 10_000), 0);
  assert.equal(connectedElapsedSeconds(5_000, 4_999), 0);
});

check('duration counts whole seconds from the connected instant', () => {
  assert.equal(connectedElapsedSeconds(1_000, 6_000), 5);
  assert.equal(connectedElapsedSeconds(1_000, 1_999), 0);
  assert.equal(connectedElapsedSeconds(1_000, 3661_000 + 1_000 - 1_000), 3660);
});

console.log('\n● Obvious call states (calling / ringing / ended / rejected / failed)');

check('spec states: idle, calling, ringing, connecting, connected', () => {
  assert.equal(obviousCallState({ direction: null, callState: null }), 'idle');
  assert.equal(
    obviousCallState({ direction: 'OUTGOING', callState: 'RINGING', callingOnly: true }),
    'calling'
  );
  assert.equal(obviousCallState({ direction: 'OUTGOING', callState: 'RINGING' }), 'ringing');
  assert.equal(obviousCallState({ direction: 'INCOMING', callState: 'RINGING' }), 'ringing');
  assert.equal(obviousCallState({ direction: 'OUTGOING', callState: 'CONNECTING' }), 'connecting');
  assert.equal(
    obviousCallState({ direction: 'OUTGOING', callState: 'CONNECTED', reconnecting: true }),
    'reconnecting'
  );
  assert.equal(obviousCallState({ direction: 'INCOMING', callState: 'CONNECTED' }), 'connected');
  assert.equal(obviousStateLabel('reconnecting'), 'Reconnecting');
  assert.equal(obviousStateLabel('missed'), 'Missed');
});

check('terminal outcomes are ended, rejected, or failed — and issues are failed', () => {
  assert.equal(
    obviousCallState({ direction: 'OUTGOING', callState: 'RINGING', terminal: 'rejected' }),
    'rejected'
  );
  assert.equal(
    obviousCallState({ direction: 'OUTGOING', callState: 'CONNECTED', terminal: 'failed' }),
    'failed'
  );
  assert.equal(
    obviousCallState({ direction: 'OUTGOING', callState: 'CONNECTED', terminal: 'ended' }),
    'ended'
  );
  assert.equal(obviousCallState({ direction: 'OUTGOING', callState: 'RINGING', issue: true }), 'failed');
  // Existing phase helper stays terminal-ended so current consumers do not drift.
  assert.equal(deriveCallPhase({ direction: 'OUTGOING', callState: 'RINGING', issue: true }), 'ended');
});

check('state labels are plain words, never raw errors', () => {
  for (const state of ['idle', 'calling', 'ringing', 'connecting', 'connected', 'reconnecting', 'ended', 'rejected', 'missed', 'failed'] as const) {
    const label = obviousStateLabel(state);
    assert.notEqual(label, '');
    assert.doesNotMatch(label, /NotAllowedError|TypeError|DOMException|undefined/);
  }
  assert.equal(obviousStateLabel('rejected'), 'Declined');
  assert.equal(obviousStateLabel('failed'), 'Failed');
});

check('decline, hang-up, and connection loss classify to different terminal states', () => {
  assert.equal(classifyCallTerminal('REJECTED', 'OUTGOING').state, 'rejected');
  assert.equal(classifyCallTerminal('LOCAL_REJECT', 'INCOMING').state, 'rejected');
  assert.equal(classifyCallTerminal('LOCAL_END', 'OUTGOING').state, 'ended');
  assert.equal(classifyCallTerminal('ENDED', 'INCOMING').state, 'ended');
  assert.equal(classifyCallTerminal('DISCONNECTED', 'OUTGOING').state, 'failed');
  assert.equal(classifyCallTerminal('FAILED', 'INCOMING').state, 'failed');
  assert.equal(classifyCallTerminal('BUSY', 'OUTGOING').state, 'failed');
  assert.equal(classifyCallTerminal('TIMEOUT', 'INCOMING').state, 'missed');
  assert.equal(classifyCallTerminal('TIMEOUT', 'INCOMING').title, 'Missed call');
  assert.equal(classifyCallTerminal('TIMEOUT', 'OUTGOING').title, 'No answer');
  assert.equal(
    obviousCallState({ direction: 'INCOMING', callState: 'RINGING', terminal: 'missed' }),
    'missed'
  );
  assert.equal(classifyCallTerminal('CANCELLED', 'INCOMING').title, 'Call cancelled');
  for (const reason of ['ENDED', 'REJECTED', 'CANCELLED', 'TIMEOUT', 'DISCONNECTED', 'BUSY', 'FAILED', 'LOCAL_END', 'LOCAL_REJECT'] as const) {
    for (const dir of ['INCOMING', 'OUTGOING'] as const) {
      const out = classifyCallTerminal(reason, dir);
      assert.doesNotMatch(`${out.title} ${out.detail}`, /NotAllowedError|NotFoundError|TypeError|DOMException/);
    }
  }
});

console.log('\n● Stale-signal guard (cleanup must not hit the next call)');

check('mute and camera UI follow the live tracks after reconnect', () => {
  assert.deepEqual(controlsFromMedia({ audioEnabled: true, videoLive: true, isVideoCall: true }), {
    muted: false,
    cameraOff: false
  });
  assert.deepEqual(controlsFromMedia({ audioEnabled: false, videoLive: false, isVideoCall: true }), {
    muted: true,
    cameraOff: true
  });
  assert.deepEqual(controlsFromMedia({ audioEnabled: null, videoLive: false, isVideoCall: false }), {
    muted: null,
    cameraOff: false
  });
  assert.equal(controlsFromMedia({ audioEnabled: true, videoLive: false, isVideoCall: false }).cameraOff, false);
});

check('speaker output selection is optional and never throws', () => {
  assert.equal(speakerOutputSupported(null), false);
  assert.equal(speakerOutputSupported({}), false);
  assert.equal(speakerOutputSupported({ setSinkId: () => Promise.resolve() }), true);
  assert.equal(typeof speakerOutputSupported(), 'boolean');
});

check('ICE restart is caller-only, once, and only after the call connected', () => {
  assert.equal(
    shouldInitiateIceRestart({ direction: 'OUTGOING', callState: 'CONNECTED', alreadyAttempted: false }),
    true
  );
  assert.equal(
    shouldInitiateIceRestart({ direction: 'OUTGOING', callState: 'CONNECTED', alreadyAttempted: true }),
    false
  );
  assert.equal(
    shouldInitiateIceRestart({ direction: 'INCOMING', callState: 'CONNECTED', alreadyAttempted: false }),
    false
  );
  assert.equal(
    shouldInitiateIceRestart({ direction: 'OUTGOING', callState: 'RINGING', alreadyAttempted: false }),
    false
  );
  assert.equal(
    shouldInitiateIceRestart({ direction: 'OUTGOING', callState: 'CONNECTING', alreadyAttempted: false }),
    false
  );
  assert.equal(shouldInitiateIceRestart({ direction: null, callState: null, alreadyAttempted: false }), false);
});

check('a signal applies only to the call id on screen', () => {
  assert.equal(
    signalAppliesToActiveCall({
      activeCallId: 'call-1',
      direction: 'OUTGOING',
      eventCallId: 'call-1',
      recentlyConcludedIds: []
    }),
    true
  );
  assert.equal(
    signalAppliesToActiveCall({
      activeCallId: 'call-2',
      direction: 'INCOMING',
      eventCallId: 'call-1',
      recentlyConcludedIds: []
    }),
    false
  );
  assert.equal(
    signalAppliesToActiveCall({
      activeCallId: null,
      direction: null,
      eventCallId: 'call-1',
      recentlyConcludedIds: []
    }),
    false
  );
});

check('caller ICE is held until the server id replaces pending-*', () => {
  assert.equal(localIceSignalCallId('pending-1', null), null);
  assert.equal(localIceSignalCallId('pending-1', 'call-real'), 'call-real');
  assert.equal(localIceSignalCallId('call-real', null), 'call-real');
  assert.equal(localIceSignalCallId(null, null), null);
});

check('an answer for the echoed id applies while the screen is still pending-*', () => {
  assert.equal(
    pendingOutgoingEventApplies({
      activeCallId: 'pending-1',
      direction: 'OUTGOING',
      eventCallId: 'call-real',
      authoritativeId: 'call-real',
      recentlyConcludedIds: []
    }),
    true
  );
  assert.equal(
    pendingOutgoingEventApplies({
      activeCallId: 'pending-1',
      direction: 'OUTGOING',
      eventCallId: 'call-other',
      authoritativeId: 'call-real',
      recentlyConcludedIds: []
    }),
    false
  );
  assert.equal(
    pendingOutgoingEventApplies({
      activeCallId: 'pending-1',
      direction: 'OUTGOING',
      eventCallId: 'call-real',
      authoritativeId: null,
      recentlyConcludedIds: []
    }),
    false
  );
  assert.equal(
    pendingOutgoingEventApplies({
      activeCallId: 'pending-1',
      direction: 'OUTGOING',
      eventCallId: 'call-old',
      authoritativeId: 'call-old',
      recentlyConcludedIds: ['call-old']
    }),
    false
  );
  assert.equal(
    pendingOutgoingEventApplies({
      activeCallId: 'call-real',
      direction: 'INCOMING',
      eventCallId: 'call-other',
      authoritativeId: 'call-other',
      recentlyConcludedIds: []
    }),
    false
  );
});

check('a late event for a concluded call cannot match a new pending attempt', () => {
  const concluded = rememberConcludedId([], 'call-old');
  assert.deepEqual(concluded, ['call-old']);
  assert.equal(
    signalAppliesToActiveCall({
      activeCallId: 'pending-9',
      direction: 'OUTGOING',
      eventCallId: 'call-old',
      recentlyConcludedIds: concluded
    }),
    false
  );
  // Pending ids are not stored — they are not server ids.
  assert.deepEqual(rememberConcludedId(concluded, 'pending-9'), concluded);
});

check('unscoped busy applies only to an in-flight outgoing attempt', () => {
  assert.equal(
    signalAppliesToActiveCall({
      activeCallId: 'pending-1',
      direction: 'OUTGOING',
      eventCallId: null,
      recentlyConcludedIds: [],
      allowUnscoped: true
    }),
    true
  );
  assert.equal(
    signalAppliesToActiveCall({
      activeCallId: 'call-live',
      direction: 'OUTGOING',
      eventCallId: null,
      recentlyConcludedIds: [],
      allowUnscoped: true
    }),
    false
  );
  assert.equal(
    signalAppliesToActiveCall({
      activeCallId: 'pending-1',
      direction: 'INCOMING',
      eventCallId: null,
      recentlyConcludedIds: [],
      allowUnscoped: true
    }),
    false
  );
});

check('network quality needs a sample and never invents a score', () => {
  assert.equal(deriveNetworkQuality({}), 'unknown');
  assert.equal(deriveNetworkQuality({ packetsReceived: 5, packetsLost: 5 }), 'unknown');
  assert.equal(deriveNetworkQuality({ packetsReceived: 100, packetsLost: 0, roundTripTimeMs: 40 }), 'good');
  assert.equal(deriveNetworkQuality({ packetsReceived: 100, packetsLost: 4, roundTripTimeMs: 40 }), 'fair');
  assert.equal(deriveNetworkQuality({ packetsReceived: 100, packetsLost: 1, roundTripTimeMs: 250 }), 'fair');
  assert.equal(deriveNetworkQuality({ packetsReceived: 100, packetsLost: 20 }), 'poor');
  assert.equal(deriveNetworkQuality({ roundTripTimeMs: 500 }), 'poor');
  assert.equal(deriveNetworkQuality({ reconnecting: true, packetsReceived: 100, packetsLost: 0 }), 'poor');
  assert.equal(networkQualityLabel('unknown'), '');
  assert.doesNotMatch(networkQualityLabel('poor'), /NotAllowedError|TypeError/);
});

check('stats summary reads inbound loss and the selected pair RTT only', () => {
  const summary = summarizeCallStats([
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: 80, packetsLost: 2 },
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 20, packetsLost: 1 },
    { type: 'candidate-pair', state: 'failed', currentRoundTripTime: 9 },
    { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.12 }
  ]);
  assert.equal(summary.packetsReceived, 100);
  assert.equal(summary.packetsLost, 3);
  assert.equal(summary.roundTripTimeMs, 120);
  assert.deepEqual(summarizeCallStats([]), {
    packetsLost: null,
    packetsReceived: null,
    roundTripTimeMs: null
  });
});

check('local preview cannot be dragged off screen', () => {
  assert.deepEqual(
    clampPreviewPosition({ x: -40, y: 900 }, { width: 390, height: 700 }, { width: 112, height: 160 }, 12),
    { x: 12, y: 528 }
  );
  assert.deepEqual(
    clampPreviewPosition({ x: 40, y: 80 }, { width: 390, height: 700 }, { width: 112, height: 160 }, 12),
    { x: 40, y: 80 }
  );
});

check('concluded-id memory is capped so it cannot grow without bound', () => {
  let ids: string[] = [];
  for (let n = 0; n < 20; n += 1) ids = rememberConcludedId(ids, `call-${n}`);
  assert.equal(ids.length, 8);
  assert.equal(ids[0], 'call-12');
  assert.equal(ids[7], 'call-19');
});

console.log('\n════════════════════════════════════');
console.log(`PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
