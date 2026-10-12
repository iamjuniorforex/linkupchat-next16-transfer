/**
 * Phase 4B — WebRTC voice engine + call sounds unit tests.
 *
 * MOCK-based: RTCPeerConnection / navigator.mediaDevices / AudioContext are
 * fakes injected on the globals. These tests verify the ENGINE's lifecycle
 * (offer/answer, ICE queueing, mute, cleanup, failure paths) — NOT real audio
 * connectivity. Real media flow is verified separately by
 * tests/calls-voice.browser.e2e.ts (two browsers + fake microphone devices).
 *
 * Run: npm run test:call-engine
 */
import assert from 'node:assert/strict';
import { CallEngine, DISCONNECT_GRACE_MS, type EngineError, type EngineState } from '../src/lib/call-engine';
import { CallSounds, type SoundClock } from '../src/lib/call-sounds';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
    });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── WebRTC fakes ─────────────────────────────────────────────────────────

class FakeTrack {
  kind: string;
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  stopCalls = 0;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  constructor(kind: string) {
    this.kind = kind;
  }
  stop() {
    this.readyState = 'ended';
    this.stopCalls++;
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  connectionState = 'new';
  iceConnectionState = 'new';
  closed = false;
  senders: { track: FakeTrack | null; replaceTrack: (t: FakeTrack | null) => Promise<void> }[] = [];
  remoteCandidates: unknown[] = [];
  iceGatheringState = 'new';
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ontrack: ((e: { streams: FakeStream[]; track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;

  constructor(_config?: unknown) {
    FakePeerConnection.instances.push(this);
  }
  addTrack(track: FakeTrack) {
    const sender: { track: FakeTrack | null; replaceTrack: (t: FakeTrack | null) => Promise<void> } = {
      track,
      replaceTrack: async (t) => {
        sender.track = t;
      }
    };
    this.senders.push(sender);
  }
  getSenders() {
    return this.senders;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0-offer' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0-answer' };
  }
  async setLocalDescription(d: unknown) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: unknown) {
    if (this.remoteDescription) throw new Error('InvalidStateError: remote description already set');
    this.remoteDescription = d;
  }
  async addIceCandidate(c: unknown) {
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description');
    this.remoteCandidates.push(c);
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  async getStats() {
    return new Map();
  }
}

let getUserMediaImpl: (constraints: MediaStreamConstraints) => Promise<unknown>;
function installWebRtcFakes() {
  FakePeerConnection.instances = [];
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: (c: MediaStreamConstraints) => getUserMediaImpl(c)
      }
    }
  });
  getUserMediaImpl = async (c) => {
    const tracks = [new FakeTrack('audio')];
    if (c.video) tracks.push(new FakeTrack('video'));
    return new FakeStream(tracks);
  };
}

function freshEngine() {
  const errors: EngineError[] = [];
  const states: EngineState[] = [];
  const remote: unknown[] = [];
  const locals: MediaStream[] = [];
  const remoteMutes: { kind: string; muted: boolean }[] = [];
  const engine = new CallEngine(
    {
      onError: (e) => errors.push(e),
      onStateChange: (s) => states.push(s),
      onRemoteStream: (s) => remote.push(s),
      onLocalStream: (s) => locals.push(s),
      onRemoteTrackMuted: (kind, muted) => remoteMutes.push({ kind, muted })
    },
    { iceServers: [] }
  );
  return { engine, errors, states, remote, locals, remoteMutes };
}

async function main() {
  installWebRtcFakes();

  console.log('■ call-engine: media + setup');
  await check('acquires the microphone for VOICE (audio only)', async () => {
    let constraints: MediaStreamConstraints | null = null;
    getUserMediaImpl = async (c) => {
      constraints = c;
      return new FakeStream([new FakeTrack('audio')]);
    };
    const { engine } = freshEngine();
    const stream = await engine.acquireLocalMedia('VOICE');
    assert.ok(stream);
    assert.deepEqual(constraints, { audio: true, video: false });
    assert.equal(engine.getState(), 'ready');
    engine.dispose();
  });

  await check('permission denial → typed error, no resources kept', async () => {
    getUserMediaImpl = async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    };
    const { engine, errors } = freshEngine();
    const stream = await engine.acquireLocalMedia('VOICE');
    assert.equal(stream, null);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.kind, 'permission');
    assert.equal(engine.getLocalStream(), null);
    assert.equal(FakePeerConnection.instances.length, 0, 'no peer connection created');
    engine.dispose();
  });

  await check('media failure (no device) → media error, no resources kept', async () => {
    getUserMediaImpl = async () => {
      throw Object.assign(new Error('no device'), { name: 'NotFoundError' });
    };
    const { engine, errors } = freshEngine();
    const stream = await engine.acquireLocalMedia('VOICE');
    assert.equal(stream, null);
    assert.equal(errors[0]!.kind, 'media');
    engine.dispose();
  });

  await check('createOffer builds one peer connection with local tracks', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    const offer = await engine.createOffer();
    assert.equal(offer?.type, 'offer');
    assert.equal(FakePeerConnection.instances.length, 1);
    const pc = FakePeerConnection.instances[0]!;
    assert.equal(pc.senders.length, 1, 'local audio track attached');
    assert.ok(pc.localDescription);
    assert.equal(engine.getState(), 'connecting');
    // a second createOffer must not create a duplicate peer connection
    await engine.createOffer();
    assert.equal(FakePeerConnection.instances.length, 1);
    engine.dispose();
  });

  console.log('\n■ call-engine: offer/answer + ICE queueing');
  await check('callee acceptOffer applies remote offer and answers', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    const answer = await engine.acceptOffer({ type: 'offer', sdp: 'remote-offer' });
    assert.equal(answer?.type, 'answer');
    const pc = FakePeerConnection.instances[0]!;
    assert.equal(pc.remoteDescription != null, true);
    assert.equal(engine.getState(), 'connecting');
    engine.dispose();
  });

  await check('ICE candidates arriving BEFORE the remote description are queued then flushed', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.addRemoteCandidate({ candidate: 'early-1', sdpMid: '0' });
    await engine.addRemoteCandidate({ candidate: 'early-2', sdpMid: '0' });
    let pc = FakePeerConnection.instances[0];
    assert.ok(!pc, 'no peer connection yet — candidates must be queued');

    await engine.acceptOffer({ type: 'offer', sdp: 'remote-offer' });
    pc = FakePeerConnection.instances[0]!;
    assert.equal(pc!.remoteCandidates.length, 2, `flushed=${pc!.remoteCandidates.length}`);
    // and candidates after the remote description go straight through
    await engine.addRemoteCandidate({ candidate: 'late-3', sdpMid: '0' });
    assert.equal(pc!.remoteCandidates.length, 3);
    engine.dispose();
  });

  await check('caller applyAnswer: duplicate answers are harmless', async () => {
    installWebRtcFakes();
    const { engine, errors } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    await engine.applyAnswer({ type: 'answer', sdp: 'remote-answer' });
    await engine.applyAnswer({ type: 'answer', sdp: 'remote-answer-2' }); // replay
    const pc = FakePeerConnection.instances[0]!;
    assert.equal((pc.remoteDescription as { sdp: string }).sdp, 'remote-answer', 'first answer wins');
    assert.equal(errors.length, 0, 'no error surfaced for the replay');
    engine.dispose();
  });

  await check('local ICE candidates are emitted through the callback', async () => {
    installWebRtcFakes();
    const seen: unknown[] = [];
    const engine = new CallEngine({ onIceCandidate: (c) => seen.push(c) }, { iceServers: [] });
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'c1' }) } });
    pc.onicecandidate?.({ candidate: null }); // end-of-candidates → ignored
    assert.equal(seen.length, 1);
    engine.dispose();
  });

  await check('remote track/stream is announced exactly once', async () => {
    installWebRtcFakes();
    const { engine, remote } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    const remoteStream = new FakeStream([new FakeTrack('audio')]);
    pc.ontrack?.({ streams: [remoteStream], track: remoteStream.getAudioTracks()[0]! });
    pc.ontrack?.({ streams: [remoteStream], track: remoteStream.getAudioTracks()[0]! });
    assert.equal(remote.length, 1, 'announced once');
    assert.equal(engine.getRemoteStream(), remoteStream);
    engine.dispose();
  });

  console.log('\n■ call-engine: connection state + failures');
  await check('connected → state connected; failed → grace window, then rtc error + failed state', async () => {
    installWebRtcFakes();
    const { engine, errors, states } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    assert.equal(engine.getState(), 'connected');

    pc.connectionState = 'failed';
    pc.onconnectionstatechange?.();
    // Phase 4E: a failed connection is given the same grace window as a
    // disconnected one — temporary failures must not kill a recoverable call.
    assert.equal(engine.getState(), 'disconnected', 'grace window, not instant death');
    assert.equal(errors.length, 0, 'no error while the call is recoverable');
    await sleep(DISCONNECT_GRACE_MS + 150);
    assert.equal(engine.getState(), 'failed');
    assert.ok(errors.some((e) => e.kind === 'rtc'));
    assert.ok(states.includes('connected') && states.includes('failed'));
    engine.dispose();
  });

  await check('ICE failure enters the grace window and surfaces an rtc error if unrecovered', async () => {
    installWebRtcFakes();
    const { engine, errors } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    pc.iceConnectionState = 'failed';
    pc.oniceconnectionstatechange?.();
    assert.equal(engine.getState(), 'disconnected', 'ICE failure is recoverable within grace');
    assert.equal(errors.length, 0);
    await sleep(DISCONNECT_GRACE_MS + 150);
    assert.ok(errors.some((e) => e.kind === 'rtc'));
    assert.equal(engine.getState(), 'failed');
    engine.dispose();
  });

  await check('temporary ICE failure that recovers within the grace window keeps the call alive', async () => {
    installWebRtcFakes();
    const { engine, errors } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    pc.iceConnectionState = 'failed';
    pc.oniceconnectionstatechange?.();
    pc.iceConnectionState = 'connected';
    pc.oniceconnectionstatechange?.();
    await sleep(DISCONNECT_GRACE_MS + 150);
    assert.equal(engine.getState(), 'connected', 'call survived the flap');
    assert.equal(errors.length, 0, 'no error after recovery');
    engine.dispose();
  });

  await check(`disconnected longer than ${DISCONNECT_GRACE_MS}ms counts as failure`, async () => {
    installWebRtcFakes();
    const { engine, errors } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange?.();
    assert.equal(engine.getState(), 'disconnected');
    await sleep(DISCONNECT_GRACE_MS + 150);
    assert.equal(engine.getState(), 'failed');
    assert.ok(errors.some((e) => e.message.includes('connection was lost')));
    engine.dispose();
  });

  await check('reconnection during the grace window keeps the call alive', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange?.();
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await sleep(DISCONNECT_GRACE_MS + 150);
    assert.equal(engine.getState(), 'connected', 'grace timer was cancelled on reconnect');
    engine.dispose();
  });

  console.log('\n■ call-engine: Phase 4E ICE config + diagnostics');

  await check('RTCPeerConnection is created with the server-provided ICE servers', async () => {
    installWebRtcFakes();
    const rtcConfig = {
      iceServers: [
        { urls: ['stun:s.example:3478'] },
        { urls: ['turn:r.example:3478', 'turn:r.example:3478?transport=tcp'], username: 'u', credential: 'c' }
      ]
    };
    const engine = new CallEngine({}, rtcConfig);
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const d = engine.getDiagnostics();
    assert.equal(d.iceServerCount, 2, 'both ICE servers applied to the pc');
    assert.equal(d.turnServerCount, 1, 'TURN server counted');
    engine.dispose();
  });

  await check('diagnostics track connection/ICE/gathering state and contain no secrets', async () => {
    installWebRtcFakes();
    const engine = new CallEngine(
      {},
      { iceServers: [{ urls: 'turn:r.example:3478', username: 'secret-user', credential: 'secret-cred' }] }
    );
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    pc.iceConnectionState = 'connected';
    pc.oniceconnectionstatechange?.();
    pc.iceGatheringState = 'complete';
    pc.onicegatheringstatechange?.();
    const d = engine.getDiagnostics();
    assert.equal(d.state, 'connected');
    assert.equal(d.connectionState, 'connected');
    assert.equal(d.iceConnectionState, 'connected');
    assert.equal(d.iceGatheringState, 'complete');
    assert.equal(d.iceServerCount, 1);
    assert.equal(d.turnServerCount, 1);
    const flat = JSON.stringify(d);
    assert.ok(!flat.includes('secret-cred'), 'diagnostics never carry credentials');
    assert.ok(!flat.includes('secret-user'), 'diagnostics never carry usernames');
    assert.ok(!flat.includes('r.example'), 'diagnostics never carry ICE URLs');
    engine.dispose();
  });

  await check('diagnostics defaults are safe before any peer connection exists', () => {
    installWebRtcFakes();
    const engine = new CallEngine({}, { iceServers: [] });
    const d = engine.getDiagnostics();
    assert.equal(d.connectionState, null);
    assert.equal(d.iceConnectionState, null);
    assert.equal(d.iceGatheringState, null);
    assert.equal(d.iceServerCount, 0);
    engine.dispose();
  });

  console.log('\n■ call-engine: mute + cleanup');
  await check('mute/unmute toggles the local audio track without renegotiation', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    const stream = (await engine.acquireLocalMedia('VOICE')) as unknown as FakeStream;
    await engine.createOffer();
    const pcCount = FakePeerConnection.instances.length;
    engine.setMuted(true);
    assert.equal(stream.getAudioTracks()[0]!.enabled, false);
    assert.equal(engine.isMuted(), true);
    engine.setMuted(false);
    assert.equal(stream.getAudioTracks()[0]!.enabled, true);
    assert.equal(engine.isMuted(), false);
    assert.equal(FakePeerConnection.instances.length, pcCount, 'mute caused no renegotiation');
    engine.dispose();
  });

  await check('dispose stops every track, closes the pc and is idempotent', async () => {
    installWebRtcFakes();
    const { engine, states } = freshEngine();
    const stream = (await engine.acquireLocalMedia('VOICE')) as unknown as FakeStream;
    await engine.createOffer();
    await engine.addRemoteCandidate({ candidate: 'early' });
    const pc = FakePeerConnection.instances[0]!;
    engine.dispose();
    assert.equal(stream.getAudioTracks()[0]!.stopCalls >= 1, true, 'mic track stopped');
    assert.equal(pc.closed, true);
    assert.equal(engine.getState(), 'closed');
    assert.ok(states.includes('closed'));
    // idempotent + late events are no-ops
    engine.dispose();
    await engine.addRemoteCandidate({ candidate: 'late' });
    assert.equal(await engine.createOffer(), null);
    assert.equal(await engine.acceptOffer({ type: 'offer', sdp: 'x' }), null);
  });

  await check('dispose during getUserMedia stops the stream that arrives later', async () => {
    installWebRtcFakes();
    let release!: (s: unknown) => void;
    getUserMediaImpl = () => new Promise((r) => (release = r));
    const { engine } = freshEngine();
    const pending = engine.acquireLocalMedia('VOICE');
    engine.dispose();
    const lateStream = new FakeStream([new FakeTrack('audio')]);
    release(lateStream);
    const result = await pending;
    assert.equal(result, null);
    assert.equal(lateStream.getAudioTracks()[0]!.stopCalls >= 1, true, 'late mic stream stopped');
  });

  // ── Phase 4C: video capture + camera toggle ────────────────────────────
  console.log('\n■ call-engine: video + camera toggle');

  await check('acquires camera + mic for VIDEO (front camera) and reports video capability', async () => {
    installWebRtcFakes();
    let constraints: MediaStreamConstraints | null = null;
    getUserMediaImpl = async (c) => {
      constraints = c;
      return new FakeStream([new FakeTrack('audio'), new FakeTrack('video')]);
    };
    const { engine } = freshEngine();
    const stream = (await engine.acquireLocalMedia('VIDEO')) as unknown as FakeStream;
    assert.ok(stream);
    assert.deepEqual(constraints, { audio: true, video: { facingMode: 'user' } });
    assert.equal(stream.getAudioTracks().length, 1);
    assert.equal(stream.getVideoTracks().length, 1);
    assert.equal(engine.hasLocalVideo(), true);
    assert.equal(engine.isCameraEnabled(), true);
    engine.dispose();
  });

  await check('VOICE calls never touch the camera (setCameraEnabled is a no-op)', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const pcCount = FakePeerConnection.instances.length;
    assert.equal(await engine.setCameraEnabled(true), false);
    assert.equal(await engine.setCameraEnabled(false), false);
    assert.equal(engine.hasLocalVideo(), false);
    assert.equal(FakePeerConnection.instances.length, pcCount);
    engine.dispose();
  });

  await check('camera OFF stops the capture and detaches the sender; the microphone keeps flowing', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    const stream = (await engine.acquireLocalMedia('VIDEO')) as unknown as FakeStream;
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    const vSender = pc.senders.find((s) => s.track?.kind === 'video')!;
    assert.ok(vSender);
    const pcCount = FakePeerConnection.instances.length;

    assert.equal(await engine.setCameraEnabled(false), true);
    assert.equal(stream.getVideoTracks().length, 0, 'video track removed from the local stream');
    assert.equal(vSender.track, null, 'video sender detached (no video being sent)');
    assert.equal(engine.hasLocalVideo(), false);
    assert.equal(engine.isCameraEnabled(), false);
    // microphone untouched
    assert.equal(stream.getAudioTracks().length, 1);
    assert.equal(stream.getAudioTracks()[0]!.enabled, true);
    assert.equal(engine.isMuted(), false);
    assert.equal(FakePeerConnection.instances.length, pcCount, 'camera off caused no renegotiation');
    engine.dispose();
  });

  await check('camera ON re-acquires a fresh video track via replaceTrack (no renegotiation)', async () => {
    installWebRtcFakes();
    const { engine, locals } = freshEngine();
    const stream = (await engine.acquireLocalMedia('VIDEO')) as unknown as FakeStream;
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    const vSender = pc.senders.find((s) => s.track?.kind === 'video')!;
    const oldVideo = stream.getVideoTracks()[0]!;
    await engine.setCameraEnabled(false);
    assert.equal(oldVideo.stopCalls >= 1, true, 'old video capture was stopped');

    let reacquireConstraints: MediaStreamConstraints | null = null;
    getUserMediaImpl = async (c) => {
      reacquireConstraints = c;
      return new FakeStream([new FakeTrack('video')]);
    };
    const localAnnouncements = locals.length;
    const pcCount = FakePeerConnection.instances.length;

    assert.equal(await engine.setCameraEnabled(true), true);
    assert.deepEqual(reacquireConstraints, { video: { facingMode: 'user' } }, 'camera-only re-acquisition');
    assert.equal(stream.getVideoTracks().length, 1);
    assert.equal(stream.getVideoTracks()[0]!.enabled, true);
    assert.equal((vSender.track as unknown as FakeTrack)?.kind, 'video', 'sender re-attached');
    assert.equal(engine.hasLocalVideo(), true);
    assert.equal(engine.isCameraEnabled(), true);
    assert.equal(locals.length, localAnnouncements + 1, 'preview re-announced');
    assert.equal(stream.getAudioTracks()[0]!.enabled, true, 'microphone never stopped');
    assert.equal(FakePeerConnection.instances.length, pcCount, 'camera on caused no renegotiation');
    engine.dispose();
  });

  await check('camera re-acquisition failure → media error, call continues audio-only', async () => {
    installWebRtcFakes();
    const { engine, errors } = freshEngine();
    await engine.acquireLocalMedia('VIDEO');
    await engine.createOffer();
    await engine.setCameraEnabled(false);
    getUserMediaImpl = async () => {
      throw Object.assign(new Error('Camera busy'), { name: 'NotReadableError' });
    };
    assert.equal(await engine.setCameraEnabled(true), false);
    assert.equal(errors.some((e) => e.kind === 'media'), true);
    assert.equal(engine.hasLocalVideo(), false);
    // microphone still live
    const stream = (engine.getLocalStream() as unknown as FakeStream)!;
    assert.equal(stream.getAudioTracks()[0]!.enabled, true);
    engine.dispose();
  });

  await check('remote track mute/unmute (camera state) is surfaced through the callback', async () => {
    installWebRtcFakes();
    const { engine, remoteMutes } = freshEngine();
    await engine.acquireLocalMedia('VIDEO');
    await engine.createOffer();
    const pc = FakePeerConnection.instances[0]!;
    const remoteVideo = new FakeTrack('video');
    pc.ontrack?.({ streams: [new FakeStream([remoteVideo])], track: remoteVideo });
    remoteVideo.onmute?.();
    remoteVideo.onunmute?.();
    assert.deepEqual(remoteMutes, [
      { kind: 'video', muted: true },
      { kind: 'video', muted: false }
    ]);
    engine.dispose();
  });

  await check('dispose stops BOTH video and audio tracks of a VIDEO call', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    const stream = (await engine.acquireLocalMedia('VIDEO')) as unknown as FakeStream;
    await engine.createOffer();
    engine.dispose();
    assert.equal(stream.getVideoTracks()[0]!.stopCalls >= 1, true, 'video track stopped');
    assert.equal(stream.getAudioTracks()[0]!.stopCalls >= 1, true, 'audio track stopped');
  });

  await check('stale-generation guards: setCameraEnabled after dispose is false; late camera stream is stopped', async () => {
    installWebRtcFakes();
    const { engine } = freshEngine();
    await engine.acquireLocalMedia('VIDEO');
    await engine.createOffer();
    engine.dispose();
    assert.equal(await engine.setCameraEnabled(true), false);
    assert.equal(await engine.setCameraEnabled(false), false);

    // dispose DURING a camera re-acquisition → the late stream is stopped
    installWebRtcFakes();
    const { engine: engine2 } = freshEngine();
    await engine2.acquireLocalMedia('VIDEO');
    await engine2.createOffer();
    await engine2.setCameraEnabled(false);
    let release!: (s: unknown) => void;
    getUserMediaImpl = () => new Promise((r) => (release = r));
    const pending = engine2.setCameraEnabled(true);
    engine2.dispose();
    const lateStream = new FakeStream([new FakeTrack('video')]);
    release(lateStream);
    assert.equal(await pending, false);
    assert.equal(lateStream.getVideoTracks()[0]!.stopCalls >= 1, true, 'late camera stream stopped');
  });

  // ── CallSounds ─────────────────────────────────────────────────────────
  console.log('\n■ call-sounds: loops, autoplay block, cleanup');

  class FakeOsc {
    started = false;
    stopped = false;
    type = 'sine';
    frequency = { value: 0 };
    onended: (() => void) | null = null;
    connect() {}
    disconnect() {}
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
      this.onended?.();
    }
  }
  class FakeGain {
    gain = {
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {}
    };
    connect() {}
    disconnect() {}
  }
  class FakeCtx {
    state: string;
    currentTime = 0;
    destination = {};
    oscillators: FakeOsc[] = [];
    constructor(state = 'running') {
      this.state = state;
    }
    createOscillator() {
      const o = new FakeOsc();
      this.oscillators.push(o);
      return o;
    }
    createGain() {
      return new FakeGain();
    }
    async resume() {
      if (this.state === 'suspended-fail') throw new Error('autoplay blocked');
      this.state = 'running';
    }
    async close() {
      this.state = 'closed';
    }
  }

  function installAudioFake(state = 'running') {
    const ctx = new FakeCtx(state);
    (globalThis as Record<string, unknown>).window = {
      AudioContext: function () {
        return ctx;
      }
    };
    return ctx;
  }

  function fakeClock() {
    let seq = 0;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    const clock: SoundClock = {
      setInterval: (fn, ms) => {
        timers.set(++seq, { fn, ms });
        return seq as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (id) => {
        timers.delete(id as unknown as number);
      }
    };
    return { clock, timers };
  }

  await check('ringtone and ringback loop exactly once (no duplicate loops)', () => {
    const ctx = installAudioFake('running');
    const { clock, timers } = fakeClock();
    const s = new CallSounds(clock);
    s.startRingtone();
    s.startRingtone(); // duplicate start must not stack loops
    assert.equal(timers.size, 1, `ringtone loops=${timers.size}`);
    assert.equal(s.getMode(), 'ringtone');
    assert.ok(ctx.oscillators.length >= 1, 'tone started');
    s.stopAll();
    assert.equal(timers.size, 0);
    assert.equal(s.getMode(), 'off');
    assert.ok(ctx.oscillators.every((o) => o.stopped), 'all tones stopped');

    s.startRingback();
    assert.equal(timers.size, 1);
    assert.equal(s.getMode(), 'ringback');
    s.stopAll();
    s.dispose();
  });

  await check('autoplay-blocked context is reported and never throws', async () => {
    installAudioFake('suspended-fail');
    const { clock, timers } = fakeClock();
    const s = new CallSounds(clock);
    s.startRingtone();
    assert.equal(s.isBlocked(), true, 'blocked reported');
    assert.equal(timers.size, 0, 'no sound loop started');
    assert.equal(s.getMode(), 'ringtone', 'pattern remembered');
    s.stopAll();
    s.dispose();
  });

  await check('ICE restart reuses the same peer connection and will not stack offers', async () => {
    installWebRtcFakes();
    const { engine, errors } = freshEngine();
    await engine.acquireLocalMedia('VOICE');
    await engine.createOffer();
    const before = FakePeerConnection.instances.length;
    assert.equal(await engine.beginIceRestart(), null, 'healthy call does not restart');
    const pc = FakePeerConnection.instances[0]!;
    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange?.();
    const offer = await engine.beginIceRestart();
    assert.equal(offer?.type, 'offer');
    assert.equal(FakePeerConnection.instances.length, before, 'no second peer connection');
    assert.equal(await engine.beginIceRestart(), null, 'second restart while one is in flight is refused');
    const answer = await engine.acceptIceRestart({ type: 'offer', sdp: 'v=0-restart-offer' });
    assert.equal(answer?.type, 'answer');
    assert.equal(await engine.completeIceRestart({ type: 'answer', sdp: 'v=0-restart-answer' }), true);
    assert.equal(engine.getLocalStream()?.getTracks().every((t) => t.readyState === 'live'), true);
    assert.equal(errors.filter((e) => e.kind === 'rtc').length, 0);
    engine.dispose();
  });

  await check('resumeOnGesture unblocks and restarts the pending pattern', async () => {
    installAudioFake('suspended');
    const { clock, timers } = fakeClock();
    const s = new CallSounds(clock);
    s.startRingtone();
    assert.equal(s.isBlocked(), true);
    await s.resumeOnGesture(); // a real user tap
    assert.equal(s.isBlocked(), false);
    assert.equal(timers.size, 1, 'ringtone loop started after the gesture');
    s.stopAll();
    s.dispose();
  });
}

main().then(() => {
  console.log('\n════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  process.exit(failed ? 1 : 0);
});
