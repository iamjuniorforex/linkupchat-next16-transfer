/**
 * Phase 4B — WebRTC voice engine (framework-free, unit-testable).
 *
 * Owns the complete peer-connection lifecycle for a 1-to-1 call:
 *   getUserMedia → RTCPeerConnection → offer/answer → ICE (with early-candidate
 *   queueing) → remote audio → connection state → cleanup.
 *
 * Media flows peer-to-peer (or via TURN relay when configured) — NEVER through
 * Socket.IO. The surrounding provider wires engine callbacks to the signaling
 * socket and to React state; this module knows nothing about either.
 *
 * Testability: `RTCPeerConnection`, `navigator.mediaDevices` and timers are
 * read from the globals at call time so unit tests can inject fakes.
 */

import { pickNextCameraDeviceId, switchableCameraDeviceIds } from './call-phase';

export type MediaKind = 'VOICE' | 'VIDEO';

export type EngineState =
  | 'idle'
  | 'getting-media'
  | 'ready'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export type EngineErrorKind = 'permission' | 'media' | 'rtc';

export interface EngineError {
  kind: EngineErrorKind;
  message: string;
  name?: string;
}

export interface EngineCallbacks {
  onLocalStream?: (stream: MediaStream) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onIceCandidate?: (candidate: RTCIceCandidateInit) => void;
  onStateChange?: (state: EngineState, detail?: string) => void;
  onError?: (error: EngineError) => void;
  /** The remote peer muted/unmuted one of their tracks (e.g. camera on/off). */
  onRemoteTrackMuted?: (kind: 'audio' | 'video', muted: boolean) => void;
}

/** How long a 'disconnected' ICE/peer state may last before it counts as failed. */
export const DISCONNECT_GRACE_MS = 5_000;

function isPermissionError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}

export class CallEngine {
  private cb: EngineCallbacks;
  private config: RTCConfiguration;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  /** The video sender (kept even while its track is detached by camera-off). */
  private videoSender: RTCRtpSender | null = null;
  /** Whether this call captured video at start (camera-off must not lose it). */
  private isVideoCall = false;
  /** Live connection diagnostics (Phase 4E — non-sensitive state names only). */
  private diag = {
    connectionState: null as string | null,
    iceConnectionState: null as string | null,
    iceGatheringState: null as string | null
  };
  /** ICE candidates that arrived before the remote description was applied. */
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionApplied = false;
  private state: EngineState = 'idle';
  private disposed = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteStreamAnnounced = false;
  /** One ICE restart offer is in flight. A second must not be created. */
  private iceRestartInFlight = false;

  constructor(callbacks: EngineCallbacks = {}, config?: RTCConfiguration) {
    this.cb = callbacks;
    this.config = config ?? { iceServers: [] };
  }

  getState(): EngineState {
    return this.state;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  private setState(state: EngineState, detail?: string) {
    if (this.disposed && state !== 'closed') return;
    if (state === 'connected') this.iceRestartInFlight = false;
    this.state = state;
    this.cb.onStateChange?.(state, detail);
  }

  private fail(kind: EngineErrorKind, message: string, name?: string) {
    this.cb.onError?.({ kind, message, name });
  }

  /**
   * Acquire the microphone (and camera for VIDEO — Phase 4C). Resolves with
   * the local stream; on denial/failure the engine reports a typed error and
   * leaves no resources behind.
   */
  async acquireLocalMedia(type: MediaKind): Promise<MediaStream | null> {
    if (this.disposed) return null;
    this.setState('getting-media');
    try {
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia) {
        throw Object.assign(new Error('Media capture is not supported in this browser.'), {
          name: 'NotSupportedError'
        });
      }
      const stream = await media.getUserMedia({
        audio: true,
        // VIDEO calls capture the front camera alongside the microphone;
        // VOICE calls never touch the camera.
        video: type === 'VIDEO' ? { facingMode: 'user' } : false
      });
      if (this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }
      this.isVideoCall = type === 'VIDEO';
      this.localStream = stream;
      this.cb.onLocalStream?.(stream);
      this.setState('ready');
      return stream;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (isPermissionError(err)) {
        this.fail('permission', 'Microphone permission was denied.', e.name);
      } else {
        this.fail('media', e.message ?? 'Could not access the microphone.', e.name);
      }
      this.setState('failed', 'media');
      return null;
    }
  }

  /**
   * Use a stream that another engine already captured. Group mesh shares one
   * microphone/camera across peer connections so a second getUserMedia is not
   * opened. 1:1 calls keep using acquireLocalMedia.
   */
  adoptLocalStream(stream: MediaStream, type: MediaKind): boolean {
    if (this.disposed) return false;
    this.isVideoCall = type === 'VIDEO';
    this.localStream = stream;
    this.setState('ready');
    return true;
  }

  /** Attach a video sender when the shared camera track is currently off. */
  ensureVideoSender(): void {
    if (!this.pc || !this.isVideoCall || this.videoSender) return;
    this.videoSender = this.pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
  }

  /** Replace the outbound video track without stopping a shared camera track. */
  async setOutboundVideoTrack(track: MediaStreamTrack | null): Promise<boolean> {
    if (this.disposed || !this.videoSender) return false;
    try {
      await this.videoSender.replaceTrack(track);
      return !this.disposed;
    } catch {
      return false;
    }
  }

  /** Create the peer connection and return the local offer. */
  async createOffer(): Promise<RTCSessionDescriptionInit | null> {
    if (this.disposed || !this.localStream) return null;
    try {
      const pc = this.createPeer();
      this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream!));
      this.rememberVideoSender(pc);
      if (this.isVideoCall && !this.videoSender) {
        this.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      }
      const offer = await pc.createOffer();
      if (this.disposed) return null;
      await pc.setLocalDescription(offer);
      if (this.disposed) return null;
      this.setState('connecting');
      return offer;
    } catch (err) {
      this.fail('rtc', (err as Error).message ?? 'Could not create the call offer.', (err as { name?: string }).name);
      this.setState('failed', 'offer');
      return null;
    }
  }

  /** Callee side: apply the remote offer and return the local answer. */
  async acceptOffer(remoteSdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
    if (this.disposed || !this.localStream) return null;
    try {
      const pc = this.createPeer();
      this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream!));
      this.rememberVideoSender(pc);
      if (this.isVideoCall && !this.videoSender) {
        this.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      }
      await pc.setRemoteDescription(remoteSdp);
      this.remoteDescriptionApplied = true;
      await this.flushPendingCandidates();
      const answer = await pc.createAnswer();
      if (this.disposed) return null;
      await pc.setLocalDescription(answer);
      if (this.disposed) return null;
      this.setState('connecting');
      return answer;
    } catch (err) {
      this.fail('rtc', (err as Error).message ?? 'Could not answer the call.', (err as { name?: string }).name);
      this.setState('failed', 'answer');
      return null;
    }
  }

  /**
   * Caller side, after a connected call's ICE path drops. Reuses the existing
   * peer connection — never builds a second one. Returns null if a restart is
   * already in flight, the call was never up, or the engine is gone.
   */
  async beginIceRestart(): Promise<RTCSessionDescriptionInit | null> {
    if (this.disposed || !this.pc || !this.localStream || this.iceRestartInFlight) return null;
    if (this.state !== 'disconnected') return null;
    this.iceRestartInFlight = true;
    try {
      const pc = this.pc as RTCPeerConnection & { restartIce?: () => void };
      pc.restartIce?.();
      const offer = await pc.createOffer({ iceRestart: true });
      if (this.disposed) return null;
      await pc.setLocalDescription(offer);
      if (this.disposed) return null;
      return offer;
    } catch (err) {
      this.iceRestartInFlight = false;
      this.fail('rtc', 'Could not restart the connection.', (err as { name?: string }).name);
      return null;
    }
  }

  /** Callee side of an ICE restart: apply the new offer on the same peer connection. */
  async acceptIceRestart(remoteOffer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
    if (this.disposed || !this.pc || !this.localStream) return null;
    try {
      await this.replaceRemoteDescription(remoteOffer);
      const answer = await this.pc.createAnswer();
      if (this.disposed) return null;
      await this.pc.setLocalDescription(answer);
      if (this.disposed) return null;
      return answer;
    } catch (err) {
      this.fail('rtc', 'Could not restore the connection.', (err as { name?: string }).name);
      return null;
    }
  }

  /** Caller side: apply the restart answer. Does not open a new peer connection. */
  async completeIceRestart(remoteAnswer: RTCSessionDescriptionInit): Promise<boolean> {
    if (this.disposed || !this.pc) return false;
    try {
      await this.replaceRemoteDescription(remoteAnswer);
      this.iceRestartInFlight = false;
      return true;
    } catch (err) {
      this.iceRestartInFlight = false;
      this.fail('rtc', 'Could not restore the connection.', (err as { name?: string }).name);
      return false;
    }
  }

  /**
   * Renegotiation replaces the previous remote description. Real browsers
   * accept that in the right signaling state; test doubles that reject a
   * second set get one replacement attempt.
   */
  private async replaceRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(sdp);
    } catch {
      (pc as { remoteDescription: RTCSessionDescriptionInit | null }).remoteDescription = null;
      await pc.setRemoteDescription(sdp);
    }
    this.remoteDescriptionApplied = true;
    await this.flushPendingCandidates();
  }

  /** Caller side: apply the remote answer (then drain any queued ICE). */
  async applyAnswer(remoteSdp: RTCSessionDescriptionInit): Promise<void> {
    if (this.disposed || !this.pc) return;
    try {
      // Already applied (duplicate answer) → harmless no-op.
      if (this.pc.remoteDescription) return;
      await this.pc.setRemoteDescription(remoteSdp);
      this.remoteDescriptionApplied = true;
      await this.flushPendingCandidates();
    } catch (err) {
      this.fail('rtc', (err as Error).message ?? 'Could not apply the call answer.', (err as { name?: string }).name);
      this.setState('failed', 'answer');
    }
  }

  /**
   * Add a remote ICE candidate. Candidates arriving before the remote
   * description are queued and flushed right after it is applied — the
   * classic early-candidate race.
   */
  async addRemoteCandidate(candidate: RTCIceCandidateInit | null | undefined): Promise<void> {
    if (this.disposed || !candidate) return;
    if (!this.remoteDescriptionApplied) {
      this.pendingRemoteCandidates.push(candidate);
      return;
    }
    try {
      await this.pc?.addIceCandidate(candidate);
    } catch (err) {
      // A single bad candidate must not kill the call — report and continue.
      this.fail('rtc', (err as Error).message ?? 'Bad ICE candidate.', (err as { name?: string }).name);
    }
  }

  private async flushPendingCandidates() {
    const queued = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    for (const c of queued) {
      try {
        await this.pc?.addIceCandidate(c);
      } catch {
        // dropped candidate — non-fatal
      }
    }
  }

  /** Mute/unmute the local microphone without renegotiation (track.enabled). */
  setMuted(muted: boolean) {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  isMuted(): boolean {
    const t = this.localStream?.getAudioTracks()[0];
    return t ? !t.enabled : false;
  }

  /** Remember the video sender after tracks are attached (kept across camera-off). */
  private rememberVideoSender(pc: RTCPeerConnection) {
    if (this.videoSender) return;
    this.videoSender = pc.getSenders().find((s) => s.track?.kind === 'video') ?? null;
  }

  /**
   * Camera OFF: the video track is removed and STOPPED (the camera light goes
   * out) and the sender is detached via replaceTrack(null) — the microphone
   * track is untouched, so voice keeps flowing.
   * Camera ON: a fresh video track is captured (front camera) and attached
   * with replaceTrack — the transceiver stays, so no renegotiation happens.
   * Returns false for voice calls (no video capability) or when the camera
   * could not be re-acquired (call continues audio-only).
   */
  async setCameraEnabled(enabled: boolean): Promise<boolean> {
    if (this.disposed || !this.isVideoCall || !this.localStream || !this.videoSender) return false;
    const current = this.localStream.getVideoTracks()[0];
    if (enabled) {
      if (current && current.readyState === 'live') {
        current.enabled = true;
        await this.videoSender.replaceTrack(current);
        return !this.disposed;
      }
      // Re-acquire the camera after it was turned off mid-call.
      try {
        const media = navigator.mediaDevices;
        const fresh = await media.getUserMedia({ video: { facingMode: 'user' } });
        if (this.disposed) {
          fresh.getTracks().forEach((t: MediaStreamTrack) => t.stop());
          return false;
        }
        const track = fresh.getVideoTracks()[0];
        if (!track) {
          fresh.getTracks().forEach((t: MediaStreamTrack) => t.stop());
          return false;
        }
        this.localStream.addTrack(track);
        track.enabled = true;
        await this.videoSender.replaceTrack(track);
        if (this.disposed) return false;
        this.cb.onLocalStream?.(this.localStream);
        return true;
      } catch (err) {
        this.cb.onError?.({
          kind: 'media',
          message: (err as Error).message ?? 'Camera unavailable.',
          name: (err as { name?: string }).name
        });
        return false;
      }
    }
    if (current) {
      this.localStream.removeTrack(current);
      current.stop();
    }
    await this.videoSender.replaceTrack(null);
    return !this.disposed;
  }

  isCameraEnabled(): boolean {
    const t = this.localStream?.getVideoTracks()[0];
    return t ? t.enabled : false;
  }

  hasLocalVideo(): boolean {
    return (this.localStream?.getVideoTracks().length ?? 0) > 0;
  }

  /**
   * Switch to the next camera (front ↔ back) mid-call, without renegotiation
   * (replaceTrack on the existing video sender). Honest about support:
   *   'unsupported' — no second camera / no video call / no live session;
   *   'failed'      — a second camera exists but could not be acquired.
   * Stops the previous capture track (camera light goes out) exactly like
   * setCameraEnabled(false) does.
   */
  async switchCamera(): Promise<'switched' | 'unsupported' | 'failed'> {
    if (this.disposed || !this.isVideoCall || !this.localStream || !this.videoSender) {
      return 'unsupported';
    }
    try {
      const media = navigator.mediaDevices;
      if (!media?.enumerateDevices || !media.getUserMedia) return 'unsupported';
      const ids = switchableCameraDeviceIds(await media.enumerateDevices());
      const current = this.localStream.getVideoTracks()[0];
      const currentId = (current?.getSettings?.().deviceId as string | undefined) ?? null;
      const next = pickNextCameraDeviceId(currentId, ids);
      if (!next) return 'unsupported';
      const fresh = await media.getUserMedia({ video: { deviceId: { exact: next } } });
      if (this.disposed) {
        fresh.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        return 'unsupported';
      }
      const track = fresh.getVideoTracks()[0];
      if (!track) {
        fresh.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        return 'failed';
      }
      if (current) {
        this.localStream.removeTrack(current);
        current.stop();
      }
      this.localStream.addTrack(track);
      track.enabled = true;
      await this.videoSender.replaceTrack(track);
      if (this.disposed) return 'unsupported';
      this.cb.onLocalStream?.(this.localStream);
      return 'switched';
    } catch (err) {
      // Generic copy only — raw device errors never reach the user.
      this.cb.onError?.({
        kind: 'media',
        message: 'Camera unavailable.',
        name: (err as { name?: string }).name
      });
      return 'failed';
    }
  }

  /** Live stats snapshot (used by the browser E2E to verify real media flow). */
  async getStats(): Promise<Record<string, unknown>[]> {
    if (!this.pc) return [];
    const report = await this.pc.getStats();
    const out: Record<string, unknown>[] = [];
    report.forEach((s) => out.push(s as unknown as Record<string, unknown>));
    return out;
  }

  private createPeer(): RTCPeerConnection {
    // Never create duplicate peer connections.
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection(this.config);
    this.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate && !this.disposed) {
        this.cb.onIceCandidate?.(e.candidate.toJSON());
      }
    };

    pc.ontrack = (e) => {
      if (this.disposed) return;
      // Prefer the stream the remote peer attached; fall back to combining
      // tracks when the browser delivers bare tracks.
      const stream = e.streams[0] ?? this.remoteStream ?? new MediaStream();
      if (!e.streams[0] && this.remoteStream) this.remoteStream.addTrack(e.track);
      this.remoteStream = stream;

      // Surface the remote peer's own track toggles (camera on/off, mic mute)
      // — browsers fire mute/unmute on the receiving track.
      const kind: 'audio' | 'video' = e.track.kind === 'video' ? 'video' : 'audio';
      e.track.onmute = () => {
        if (!this.disposed) this.cb.onRemoteTrackMuted?.(kind, true);
      };
      e.track.onunmute = () => {
        if (!this.disposed) this.cb.onRemoteTrackMuted?.(kind, false);
      };

      if (!this.remoteStreamAnnounced) {
        this.remoteStreamAnnounced = true;
        this.cb.onRemoteStream?.(stream);
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.disposed) return;
      this.diag.connectionState = pc.connectionState;
      switch (pc.connectionState) {
        case 'connected':
          this.clearGrace();
          this.setState('connected');
          break;
        case 'disconnected':
          this.setState('disconnected');
          this.armGrace();
          break;
        case 'failed':
          // Phase 4E: temporary failures CAN recover (TURN fallback, network
          // flap). Give the same grace window before concluding the call is
          // dead instead of terminating an otherwise recoverable call.
          this.setState('disconnected', 'connection');
          this.armGrace();
          break;
        case 'closed':
          this.setState('closed');
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.disposed) return;
      const s = pc.iceConnectionState;
      this.diag.iceConnectionState = s;
      if (s === 'failed' || s === 'disconnected') {
        // Phase 4E: ICE failures are recoverable within the grace window —
        // do not kill the call immediately.
        this.setState('disconnected', 'ice');
        this.armGrace();
      } else if (s === 'connected' || s === 'completed') {
        this.clearGrace();
        if (this.state !== 'connected') this.setState('connected');
      }
    };

    pc.onicegatheringstatechange = () => {
      if (this.disposed) return;
      this.diag.iceGatheringState = pc.iceGatheringState;
    };

    return pc;
  }

  /**
   * Phase 4E diagnostics: connection/ICE/gathering state names plus how many
   * STUN/TURN servers the call was configured with. Contains NO URLs,
   * usernames, or credentials.
   */
  getDiagnostics(): {
    state: EngineState;
    connectionState: string | null;
    iceConnectionState: string | null;
    iceGatheringState: string | null;
    iceServerCount: number;
    turnServerCount: number;
  } {
    const servers = (this.config.iceServers ?? []) as { urls?: string | string[] }[];
    const turnServerCount = servers.filter((s) => {
      const list = Array.isArray(s.urls) ? s.urls : [s.urls ?? ''];
      return list.some((u) => typeof u === 'string' && /^turns?:/i.test(u));
    }).length;
    return {
      state: this.state,
      connectionState: this.diag.connectionState,
      iceConnectionState: this.diag.iceConnectionState,
      iceGatheringState: this.diag.iceGatheringState,
      iceServerCount: servers.length,
      turnServerCount
    };
  }

  private armGrace() {
    this.clearGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.disposed || this.state === 'connected') return;
      this.fail('rtc', 'The connection was lost.', 'Disconnected');
      this.setState('failed', 'disconnect-grace');
    }, DISCONNECT_GRACE_MS);
    if (typeof this.graceTimer.unref === 'function') this.graceTimer.unref();
  }

  private clearGrace() {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /**
   * Full teardown — idempotent. Stops every local track (microphone OFF),
   * closes the peer connection, drops queued candidates and timers, and
   * detaches callbacks so stale async continuations become no-ops.
   */
  dispose(opts?: { stopLocalTracks?: boolean }) {
    if (this.disposed) return;
    this.disposed = true;
    const stopLocal = opts?.stopLocalTracks !== false;
    this.clearGrace();
    this.pendingRemoteCandidates = [];
    this.remoteDescriptionApplied = false;
    this.remoteStreamAnnounced = false;

    try {
      if (stopLocal) {
        this.pc?.getSenders().forEach((s) => {
          try {
            s.track?.stop();
          } catch {
            /* already stopped */
          }
        });
      }
      this.pc?.close();
    } catch {
      /* closing a closed pc is fine */
    }
    this.pc = null;

    if (stopLocal) {
      this.localStream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      });
    }
    this.localStream = null;
    this.remoteStream = null;

    this.state = 'closed';
    this.cb.onStateChange?.('closed');
  }
}
