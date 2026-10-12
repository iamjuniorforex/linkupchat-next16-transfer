'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  SwitchCamera
} from 'lucide-react';
import { EVENTS, type CallSignalPayload } from '@shared/events';
import { useAuth } from './AuthProvider';
import { useSocket, useSocketEvent } from './SocketProvider';
import { Avatar } from '@/components/ui/Avatar';
import { useToast } from '@/components/ui/Toast';
import { cn, formatDuration } from '@/lib/utils';
import { CallEngine, type EngineState } from '@/lib/call-engine';
import { CallSounds } from '@/lib/call-sounds';
import {
  deriveCallPhase,
  describeCallStatus,
  mediaIssueMessage,
  listCameraDeviceIds,
  connectedElapsedSeconds,
  obviousCallState,
  obviousStateLabel,
  classifyCallTerminal,
  rememberConcludedId,
  shouldInitiateIceRestart,
  signalAppliesToActiveCall,
  localIceSignalCallId,
  pendingOutgoingEventApplies,
  controlsFromMedia,
  speakerOutputSupported,
  summarizeCallStats,
  deriveNetworkQuality,
  networkQualityLabel,
  clampPreviewPosition,
  type CallPhase,
  type CallTerminalReason,
  type NetworkQuality,
  type ObviousCallState
} from '@/lib/call-phase';
import { claimCallLock, releaseCallLock } from '@/lib/call-lock';

// ── Public context shape (additive only — existing consumers keep working) ──

export type MicPermission = 'idle' | 'requesting' | 'granted' | 'denied' | 'error';
export type CallIssue = 'PERMISSION_DENIED' | 'MEDIA_ERROR';

interface ActiveCall {
  callId: string;
  peerId: string;
  peerName: string;
  peerUsername: string;
  peerAvatar: string | null;
  type: 'VOICE' | 'VIDEO';
  direction: 'OUTGOING' | 'INCOMING';
  state: 'RINGING' | 'CONNECTING' | 'CONNECTED';
  /** Local client-side issue that keeps the overlay open with a message. */
  issue?: CallIssue | null;
  issueMessage?: string;
}

interface CallContextValue {
  activeCall: ActiveCall | null;
  muted: boolean;
  cameraOff: boolean;
  micPermission: MicPermission;
  audioBlocked: boolean;
  startCall: (
    peer: { id: string; username: string; displayName: string; avatarUrl?: string | null },
    type: 'VOICE' | 'VIDEO'
  ) => void;
  acceptCall: () => void;
  rejectCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  /** Resume remote audio after an autoplay block (must run on a user gesture). */
  resumeAudio: () => void;
  /** Dismiss a permission/media issue overlay. */
  closeIssue: () => void;
  /** Current call state-machine phase (additive). */
  phase: CallPhase;
  /** Spec-facing state: idle/calling/ringing/connecting/connected/ended/rejected/failed. */
  obviousState: ObviousCallState;
  /** True while the connection is dropped and inside the engine grace window. */
  reconnecting: boolean;
  /** Remote call-audio output is muted (speaker control). */
  speakerOff: boolean;
  toggleSpeaker: () => void;
  /** True when a second camera is available to switch to. */
  cameraSwitchable: boolean;
  switchCamera: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

/**
 * Phase 4E fallback: used only when GET /api/calls/ice is unreachable
 * (direct/STUN only — calls still work). The authoritative ICE config is
 * server-side (TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL/STUN_URLS env); TURN
 * credentials are NEVER referenced from NEXT_PUBLIC_* variables, which would
 * be inlined into the public client bundle.
 */
const FALLBACK_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};

/** Fetch the server-authoritative ICE config for a call (Phase 4E). */
async function fetchRtcConfig(): Promise<RTCConfiguration> {
  try {
    const res = await fetch('/api/calls/ice', { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return FALLBACK_RTC_CONFIG;
    const body = (await res.json()) as { data?: { iceServers?: unknown }; iceServers?: unknown };
    const servers = body.data?.iceServers ?? body.iceServers;
    if (Array.isArray(servers) && servers.length > 0) {
      return { iceServers: servers as RTCIceServer[] };
    }
    return FALLBACK_RTC_CONFIG;
  } catch {
    return FALLBACK_RTC_CONFIG;
  }
}

const ISSUE_TTL_MS = 10_000;
/** How long the ended/rejected/failed card stays up after media is released. */
const TERMINAL_TTL_MS = 2_500;

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { socket } = useSocket();
  const toast = useToast();

  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [micPermission, setMicPermission] = useState<MicPermission>('idle');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [speakerOff, setSpeakerOff] = useState(false);
  const [cameraSwitchable, setCameraSwitchable] = useState(false);

  const engineRef = useRef<CallEngine | null>(null);
  const soundsRef = useRef<CallSounds | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  /** The remote peer turned their camera off (via track mute events). */
  const [remoteCameraOff, setRemoteCameraOff] = useState(false);
  const [terminal, setTerminal] = useState<{
    state: 'ended' | 'rejected' | 'missed' | 'failed';
    title: string;
    detail: string;
    peerName: string;
  } | null>(null);
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>('unknown');
  /** Null keeps the local preview in the default mobile-safe corner. */
  const [previewOffset, setPreviewOffset] = useState<{ x: number; y: number } | null>(null);
  const previewDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const pendingOfferRef = useRef<CallSignalPayload & { fromName?: string; fromUsername?: string } | null>(null);
  /** ICE that arrived before the callee accepted (engine not created yet). */
  const pendingRemoteIceRef = useRef<RTCIceCandidateInit[]>([]);
  const callStartRef = useRef<number>(0);
  /** Generation counter — bumps on every cleanup/start so stale async
   *  continuations from a previous call become no-ops. */
  const genRef = useRef(0);
  const issueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Server call ids already torn down — late CALL_END/REJECT must not hit the next call. */
  const concludedIdsRef = useRef<string[]>([]);
  /** Reject/end that arrived before the outgoing echo replaced `pending-*`. */
  const earlyTerminalRef = useRef<{ callId: string; reason: CallTerminalReason } | null>(null);
  /**
   * Server id from the outgoing echo. Set in the socket handler, not on the
   * next render — `activeCallRef` is overwritten from state every render and
   * can still say `pending-*` when the answer arrives.
   */
  const authoritativeCallIdRef = useRef<string | null>(null);
  /** Local ICE gathered before the server id exists. Never sent as `pending-*`. */
  const pendingLocalIceRef = useRef<RTCIceCandidateInit[]>([]);
  /** Answer that arrived before the outgoing echo. Applied only if the ids match. */
  const pendingAnswerRef = useRef<{ callId: string; sdp: RTCSessionDescriptionInit | null } | null>(null);
  /** Callee ICE that arrived before the outgoing echo. Flushed only on id match. */
  const outgoingEarlyIceRef = useRef<{ callId: string; candidate: RTCIceCandidateInit }[]>([]);
  /** Caller ICE that reached the callee before CALL_OFFER was applied. */
  const preOfferIceRef = useRef<{ callId: string; candidate: RTCIceCandidateInit }[]>([]);
  /** Call the socket handlers published. A render must not wipe this before state catches up. */
  const latchedCallRef = useRef<ActiveCall | null>(null);
  /** One ICE restart attempt per drop. Cleared when the link recovers or the call ends. */
  const iceRestartAttemptedRef = useRef(false);
  const mountedRef = useRef(true);
  const actingRef = useRef(false);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  /** Kind of the last engine media error (state updates are async). */
  const lastMediaErrorRef = useRef<'permission' | 'media' | null>(null);
  const activeCallRef = useRef(activeCall);
  if (activeCall) {
    const signaled = localIceSignalCallId(activeCall.callId, authoritativeCallIdRef.current);
    const next =
      signaled && signaled !== activeCall.callId ? { ...activeCall, callId: signaled } : activeCall;
    latchedCallRef.current = next;
    activeCallRef.current = next;
  } else if (latchedCallRef.current) {
    const latchedId = authoritativeCallIdRef.current ?? latchedCallRef.current.callId;
    if (latchedId && concludedIdsRef.current.includes(latchedId)) {
      latchedCallRef.current = null;
      activeCallRef.current = null;
    } else {
      activeCallRef.current = latchedCallRef.current;
    }
  } else {
    activeCallRef.current = null;
  }

  const sounds = () => {
    if (!soundsRef.current) soundsRef.current = new CallSounds();
    return soundsRef.current;
  };

  // ── Cleanup (the single teardown path every termination uses) ─────────────
  const cleanup = useCallback(() => {
    genRef.current += 1; // invalidate in-flight async continuations
    soundsRef.current?.stopAll();
    engineRef.current?.dispose(); // stops mic tracks, closes pc, drops ICE queue
    engineRef.current = null;
    localStreamRef.current = null;
    pendingOfferRef.current = null;
    pendingRemoteIceRef.current = [];
    authoritativeCallIdRef.current = null;
    pendingLocalIceRef.current = [];
    pendingAnswerRef.current = null;
    outgoingEarlyIceRef.current = [];
    preOfferIceRef.current = [];
    latchedCallRef.current = null;
    activeCallRef.current = null;
    if (issueTimerRef.current) {
      clearTimeout(issueTimerRef.current);
      issueTimerRef.current = null;
    }
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    callStartRef.current = 0;
    setMuted(false);
    setCameraOff(false);
    setRemoteCameraOff(false);
    setMicPermission('idle');
    setAudioBlocked(false);
    setElapsed(0);
    setReconnecting(false);
    setSpeakerOff(false);
    setCameraSwitchable(false);
    setNetworkQuality('unknown');
    setPreviewOffset(null);
    previewDragRef.current = null;
    iceRestartAttemptedRef.current = false;
    actingRef.current = false;
    releaseCallLock('direct');
    setActiveCall(null);
  }, []);

  const dismissTerminal = useCallback(() => {
    if (terminalTimerRef.current) {
      clearTimeout(terminalTimerRef.current);
      terminalTimerRef.current = null;
    }
    setTerminal(null);
  }, []);

  /**
   * Single conclusion path: release media immediately (no stale tracks or
   * peer connection), then show ended/rejected/failed briefly and clear it.
   */
  const finishCall = useCallback(
    (reason: CallTerminalReason, eventCallId?: string | null) => {
      const call = activeCallRef.current;
      if (!call) return;
      concludedIdsRef.current = rememberConcludedId(concludedIdsRef.current, call.callId);
      concludedIdsRef.current = rememberConcludedId(concludedIdsRef.current, eventCallId);
      concludedIdsRef.current = rememberConcludedId(
        concludedIdsRef.current,
        authoritativeCallIdRef.current
      );
      earlyTerminalRef.current = null;
      const outcome = classifyCallTerminal(reason, call.direction);
      const peerName = call.peerName && call.peerName !== 'Call' ? call.peerName : '';
      cleanup();
      setTerminal({ ...outcome, peerName });
      if (terminalTimerRef.current) clearTimeout(terminalTimerRef.current);
      terminalTimerRef.current = setTimeout(() => {
        terminalTimerRef.current = null;
        setTerminal(null);
      }, TERMINAL_TTL_MS);
    },
    [cleanup]
  );
  const finishCallRef = useRef(finishCall);
  finishCallRef.current = finishCall;

  const eventMatchesActive = useCallback((eventCallId: string | null | undefined, allowUnscoped = false) => {
    const call = activeCallRef.current;
    if (
      signalAppliesToActiveCall({
        activeCallId: call?.callId ?? null,
        direction: call?.direction ?? null,
        eventCallId,
        recentlyConcludedIds: concludedIdsRef.current,
        allowUnscoped
      })
    ) {
      return true;
    }
    // Outgoing echo already replaced the id, but this render still shows pending-*.
    return pendingOutgoingEventApplies({
      activeCallId: call?.callId ?? null,
      direction: call?.direction ?? null,
      eventCallId,
      authoritativeId: authoritativeCallIdRef.current,
      recentlyConcludedIds: concludedIdsRef.current
    });
  }, []);

  const outboundCallId = (callId: string | null | undefined) =>
    localIceSignalCallId(callId ?? null, authoritativeCallIdRef.current) ?? (callId || null);

  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;

  /** Stop media/sound but keep the overlay open to show a local issue. */
  const showIssue = useCallback((issue: CallIssue, message: string, call: ActiveCall | null) => {
    soundsRef.current?.stopAll();
    engineRef.current?.dispose();
    engineRef.current = null;
    localStreamRef.current = null;
    pendingRemoteIceRef.current = [];
    pendingLocalIceRef.current = [];
    pendingAnswerRef.current = null;
    outgoingEarlyIceRef.current = [];
    preOfferIceRef.current = [];
    authoritativeCallIdRef.current = null;
    latchedCallRef.current = null;
    activeCallRef.current = null;
    if (issueTimerRef.current) clearTimeout(issueTimerRef.current);
    issueTimerRef.current = setTimeout(() => cleanupRef.current(), ISSUE_TTL_MS);
    if (call) {
      setActiveCall({ ...call, issue, issueMessage: message });
    } else {
      setActiveCall({
        callId: '',
        peerId: '',
        peerName: 'Call',
        peerUsername: '',
        peerAvatar: null,
        type: 'VOICE',
        direction: 'OUTGOING',
        state: 'RINGING',
        issue,
        issueMessage: message
      });
    }
  }, []);

  // Timer while connected
  useEffect(() => {
    if (activeCall?.state !== 'CONNECTED') return;
    const t = setInterval(() => setElapsed(connectedElapsedSeconds(callStartRef.current, Date.now())), 1000);
    return () => clearInterval(t);
  }, [activeCall?.state]);

  // Move keyboard focus to the primary action when a call screen opens.
  useEffect(() => {
    if (!activeCall) return;
    primaryActionRef.current?.focus();
  }, [activeCall?.callId, activeCall?.state, activeCall?.direction, activeCall?.issue]);

  // Network quality from WebRTC stats. Not shown until there is a real sample.
  useEffect(() => {
    if (activeCall?.state !== 'CONNECTED') {
      setNetworkQuality('unknown');
      return;
    }
    let cancelled = false;
    const sample = async () => {
      const stats = await engineRef.current?.getStats();
      if (cancelled || !stats) return;
      const summary = summarizeCallStats(stats);
      setNetworkQuality(deriveNetworkQuality({ ...summary, reconnecting }));
    };
    void sample();
    const t = setInterval(() => void sample(), 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activeCall?.state, reconnecting]);

  // Re-attach media to the video elements whenever the overlay (re)renders —
  // the elements mount only when the call overlay is on screen.
  useEffect(() => {
    const type = activeCall?.type;
    if (!type) return;
    if (type === 'VIDEO') {
      if (localVideoRef.current && localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      const remote = engineRef.current?.getRemoteStream() ?? null;
      if (remoteVideoRef.current && remote) remoteVideoRef.current.srcObject = remote;
    }
  }, [activeCall?.type, activeCall?.state, cameraOff, remoteCameraOff]);

  // Speaker control mutes remote playback (both media elements). That is the
  // path that works everywhere and never touches the local microphone.
  // setSinkId('') is attempted only when the browser actually implements it.
  useEffect(() => {
    if (remoteAudioRef.current) remoteAudioRef.current.muted = speakerOff;
    if (remoteVideoRef.current) remoteVideoRef.current.muted = speakerOff;
  }, [speakerOff, activeCall?.type, activeCall?.state]);

  // Full teardown when the provider unmounts (page navigation/unmount).
  // Setup must set mounted back to true: React dev Strict Mode runs this
  // cleanup once on mount, and leaving mounted false made Accept a no-op.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (terminalTimerRef.current) clearTimeout(terminalTimerRef.current);
      cleanupRef.current();
      soundsRef.current?.dispose();
    };
  }, []);

  // Engine callbacks shared by both directions.
  const makeEngine = useCallback(
    (gen: number, rtcConfig: RTCConfiguration) =>
      new CallEngine(
        {
          onLocalStream: (stream) => {
            if (gen !== genRef.current) return;
            localStreamRef.current = stream;
            if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          },
          onRemoteStream: (stream) => {
            if (gen !== genRef.current) return;
            const audioEl = remoteAudioRef.current;
            if (audioEl && activeCallRef.current?.type !== 'VIDEO') {
              audioEl.srcObject = stream;
              audioEl.play().catch(() => setAudioBlocked(true)); // autoplay policy
            }
            const videoEl = remoteVideoRef.current;
            if (videoEl && activeCallRef.current?.type === 'VIDEO') {
              videoEl.srcObject = stream;
              videoEl.play().catch(() => setAudioBlocked(true));
            }
          },
          onIceCandidate: (candidate) => {
            if (gen !== genRef.current) return;
            const call = activeCallRef.current;
            // Host candidates often finish during createOffer, before CALL_OFFER
            // is registered. Sending them as pending-* is dropped and never
            // repeated. Hold until the outgoing echo.
            const signalId = localIceSignalCallId(call?.callId ?? null, authoritativeCallIdRef.current);
            if (!signalId || !call || !socket) {
              pendingLocalIceRef.current.push(candidate);
              return;
            }
            const held = pendingLocalIceRef.current;
            pendingLocalIceRef.current = [];
            for (const queued of [...held, candidate]) {
              socket.emit(EVENTS.CALL_ICE, {
                callId: signalId,
                from: user?.id ?? '',
                to: call.peerId,
                candidate: queued
              });
            }
          },
          onStateChange: (state: EngineState) => {
            if (gen !== genRef.current) return;
            if (state === 'connected') {
              if (!mountedRef.current) return;
              if (!callStartRef.current) callStartRef.current = Date.now();
              iceRestartAttemptedRef.current = false;
              setReconnecting(false);
              const live = engineRef.current;
              const audio = live?.getLocalStream()?.getAudioTracks().find((t) => t.readyState === 'live');
              const synced = controlsFromMedia({
                audioEnabled: audio ? audio.enabled : null,
                videoLive: live?.isCameraEnabled() ?? false,
                isVideoCall: activeCallRef.current?.type === 'VIDEO'
              });
              if (synced.muted !== null) setMuted(synced.muted);
              if (activeCallRef.current?.type === 'VIDEO') setCameraOff(synced.cameraOff);
              setActiveCall((prev) => (prev ? { ...prev, state: 'CONNECTED', issue: null } : prev));
            } else if (state === 'disconnected') {
              // Connection dropped — the engine keeps a grace window before
              // failing. Surface it as the "reconnecting" phase meanwhile.
              // The caller tries one ICE restart on the same peer connection.
              setReconnecting(true);
              const call = activeCallRef.current;
              if (
                shouldInitiateIceRestart({
                  direction: call?.direction ?? null,
                  callState: call?.state ?? null,
                  alreadyAttempted: iceRestartAttemptedRef.current
                })
              ) {
                iceRestartAttemptedRef.current = true;
                const engine = engineRef.current;
                void engine?.beginIceRestart().then((offer) => {
                  const current = activeCallRef.current;
                  const signalId = localIceSignalCallId(current?.callId ?? null, authoritativeCallIdRef.current);
                  if (gen !== genRef.current || !offer || !current || !signalId || !socket) return;
                  socket.emit(EVENTS.CALL_RENEGOTIATE, {
                    callId: signalId,
                    to: current.peerId,
                    sdp: offer
                  });
                });
              }
            }
          },
          onRemoteTrackMuted: (kind, muted) => {
            if (gen !== genRef.current) return;
            // The peer toggled their camera (or mic) — reflect it in the UI so
            // a disabled remote camera shows a clear placeholder.
            if (kind === 'video') setRemoteCameraOff(muted);
          },
          onError: (err) => {
            if (gen !== genRef.current) return;
            if (err.kind === 'permission' || err.kind === 'media') {
              lastMediaErrorRef.current = err.kind;
            }
            if (err.kind === 'permission') {
              setMicPermission('denied');
            } else {
              setMicPermission((p) => (p === 'requesting' ? 'error' : p));
            }
            if (err.kind === 'rtc') {
              // Peer-connection failure: tell the server, release media, and
              // show the failed state. Raw engine messages stay off the screen.
              const call = activeCallRef.current;
              const signalId = localIceSignalCallId(call?.callId ?? null, authoritativeCallIdRef.current) ?? call?.callId;
              if (call && signalId && socket) {
                socket.emit(EVENTS.CALL_END, { callId: signalId, to: call.peerId, durationSec: 0 });
              }
              finishCallRef.current('FAILED');
            }
          }
        },
        rtcConfig
      ),
    [socket, user?.id, toast]
  );

  // ── Caller: start a call ─────────────────────────────────────────────────
  const startCall = useCallback(
    async (peer: { id: string; username: string; displayName: string; avatarUrl?: string | null }, type: 'VOICE' | 'VIDEO') => {
      if (activeCallRef.current || !claimCallLock('direct')) {
        toast.info('Already in a call');
        return;
      }
      earlyTerminalRef.current = null;
      authoritativeCallIdRef.current = null;
      pendingLocalIceRef.current = [];
      pendingAnswerRef.current = null;
      outgoingEarlyIceRef.current = [];
      preOfferIceRef.current = [];
      dismissTerminal();
      const gen = ++genRef.current;
      sounds().stopAll();
      sounds().resumeOnGesture().catch(() => {}); // started from a click → audio allowed
      setMicPermission('requesting');
      lastMediaErrorRef.current = null;

      // Phase 4E: fetch the server-authoritative ICE config (STUN + optional
      // TURN) before building the peer connection.
      const rtcConfig = await fetchRtcConfig();
      if (gen !== genRef.current) {
        releaseCallLock('direct');
        return;
      }

      const engine = makeEngine(gen, rtcConfig);
      engineRef.current = engine;
      const stream = await engine.acquireLocalMedia(type);
      if (gen !== genRef.current) {
        stream?.getTracks().forEach((t) => t.stop());
        releaseCallLock('direct');
        return; // superseded while requesting permission
      }
      if (!stream) {
        const denied = lastMediaErrorRef.current !== 'media';
        showIssue(
          denied ? 'PERMISSION_DENIED' : 'MEDIA_ERROR',
          mediaIssueMessage(denied ? 'PERMISSION_DENIED' : 'MEDIA_ERROR', type, 'OUTGOING'),
          null
        );
        return;
      }
      setMicPermission('granted');
      if (type === 'VIDEO') {
        // Show "switch camera" only when a second camera actually exists.
        void listCameraDeviceIds().then((ids) => {
          if (gen === genRef.current) setCameraSwitchable(ids.length >= 2);
        });
      }

      const callId = `pending-${Date.now()}`;
      const outgoing: ActiveCall = {
        callId,
        peerId: peer.id,
        peerName: peer.displayName,
        peerUsername: peer.username,
        peerAvatar: peer.avatarUrl ?? null,
        type,
        direction: 'OUTGOING',
        state: 'RINGING'
      };
      // Publish before createOffer so gathered ICE is held, not dropped.
      latchedCallRef.current = outgoing;
      activeCallRef.current = outgoing;
      setActiveCall(outgoing);

      const offer = await engine.createOffer();
      if (gen !== genRef.current) {
        releaseCallLock('direct');
        return;
      }
      if (!offer) {
        showIssue('MEDIA_ERROR', 'Could not start the call media session.', null);
        return;
      }
      socket?.emit(EVENTS.CALL_OFFER, {
        callId,
        from: user?.id ?? '',
        to: peer.id,
        type,
        sdp: offer
      });
      sounds().startRingback();
    },
    [dismissTerminal, makeEngine, showIssue, socket, toast, user?.id]
  );

  // ── Callee: accept the ringing call ──────────────────────────────────────
  const acceptCall = useCallback(async () => {
    const pending = pendingOfferRef.current;
    const call = activeCallRef.current;
    if (actingRef.current || !pending || !call || call.issue) return;
    actingRef.current = true;
    const gen = ++genRef.current;
    try {
      sounds().stopAll(); // ringtone off immediately
      sounds().resumeOnGesture().catch(() => {}); // accept is a user gesture
      setMicPermission('requesting');
      lastMediaErrorRef.current = null;

      // Phase 4E: same server-authoritative ICE config on the callee side.
      const rtcConfig = await fetchRtcConfig();
      if (!mountedRef.current || gen !== genRef.current) return;

      const engine = makeEngine(gen, rtcConfig);
      engineRef.current = engine;
      const stream = await engine.acquireLocalMedia(call.type);
      if (!mountedRef.current || gen !== genRef.current) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!stream) {
        // Cannot talk → decline so the caller is not left ringing, and explain.
        socket?.emit(EVENTS.CALL_REJECT, { callId: call.callId, to: call.peerId });
        showIssue(
          'PERMISSION_DENIED',
          mediaIssueMessage('PERMISSION_DENIED', call.type, 'INCOMING'),
          call
        );
        return;
      }
      setMicPermission('granted');
      if (call.type === 'VIDEO') {
        void listCameraDeviceIds().then((ids) => {
          if (mountedRef.current && gen === genRef.current) setCameraSwitchable(ids.length >= 2);
        });
      }

      const answer = pending.sdp ? await engine.acceptOffer(pending.sdp) : null;
      if (!mountedRef.current || gen !== genRef.current) return;
      if (!answer) {
        socket?.emit(EVENTS.CALL_REJECT, { callId: call.callId, to: call.peerId });
        showIssue('MEDIA_ERROR', 'Could not join the call media session.', call);
        return;
      }

      // Flush ICE that arrived while the overlay was ringing.
      for (const c of pendingRemoteIceRef.current) await engine.addRemoteCandidate(c);
      pendingRemoteIceRef.current = [];

      // Duration starts when the call actually connects — not at accept.
      setActiveCall({ ...call, state: 'CONNECTING', issue: null });
      socket?.emit(EVENTS.CALL_ACCEPT, { callId: call.callId, sdp: answer });
    } finally {
      // End/reject bump the generation and must keep winning if a newer
      // accept has already started.
      if (gen === genRef.current) actingRef.current = false;
    }
  }, [makeEngine, showIssue, socket]);

  const rejectCall = useCallback(() => {
    const call = activeCallRef.current;
    if (!call) return;
    actingRef.current = false;
    const rejectId = outboundCallId(call.callId);
    if (rejectId && socket) {
      socket.emit(EVENTS.CALL_REJECT, { callId: rejectId, to: call.peerId });
    }
    finishCall('LOCAL_REJECT');
  }, [socket, finishCall]);

  const endCall = useCallback(() => {
    const call = activeCallRef.current;
    if (!call) return;
    actingRef.current = false;
    const endId = outboundCallId(call.callId);
    if (endId && socket) {
      const durationSec =
        call.state === 'CONNECTED' && callStartRef.current
          ? Math.floor((Date.now() - callStartRef.current) / 1000)
          : 0;
      socket.emit(EVENTS.CALL_END, { callId: endId, to: call.peerId, durationSec });
    }
    finishCall(call?.state === 'RINGING' && call.direction === 'OUTGOING' ? 'CANCELLED' : 'LOCAL_END');
  }, [socket, finishCall]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      engineRef.current?.setMuted(next); // track.enabled — no renegotiation
      return next;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    // Phase 4C: camera on/off. Off = the capture track is stopped (camera
    // light out) and detached via replaceTrack — the microphone keeps
    // flowing. The peer is told over CALL_CAMERA (signaling), because
    // browsers do not reliably fire remote-track mute events.
    const next = !cameraOff;
    setCameraOff(next);
    const call = activeCallRef.current;
    const engine = engineRef.current;
    if (engine && call?.type === 'VIDEO') {
      void engine.setCameraEnabled(!next).then((ok) => {
        if (!ok && next) {
          // Could not re-acquire the camera — stay off (audio continues).
          setCameraOff(true);
          return;
        }
        const cameraCallId = outboundCallId(call.callId);
        if (cameraCallId && socket) {
          socket.emit(EVENTS.CALL_CAMERA, {
            callId: cameraCallId,
            to: call.peerId,
            videoEnabled: !next && ok
          });
        }
      });
    } else if (engine) {
      engine.setCameraEnabled(!next);
    } else {
      localStreamRef.current?.getVideoTracks().forEach((t) => {
        t.enabled = !next;
      });
    }
  }, [cameraOff, socket]);

  const resumeAudio = useCallback(() => {
    setAudioBlocked(false);
    void sounds().resumeOnGesture();
    const el = activeCallRef.current?.type === 'VIDEO' ? remoteVideoRef.current : remoteAudioRef.current;
    el?.play().catch(() => setAudioBlocked(true));
  }, []);

  const closeIssue = useCallback(() => {
    cleanup();
  }, [cleanup]);

  // Escape declines a ringing incoming call and ends every other live screen,
  // including when focus has moved off the primary button.
  useEffect(() => {
    if (!activeCall) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (activeCallRef.current?.issue) closeIssue();
      else if (activeCallRef.current?.direction === 'INCOMING' && activeCallRef.current?.state === 'RINGING') rejectCall();
      else endCall();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeCall, closeIssue, rejectCall, endCall]);

  const toggleSpeaker = useCallback(() => {
    setSpeakerOff((s) => {
      const next = !s;
      const apply = (el: HTMLMediaElement | null) => {
        if (!el) return;
        el.muted = next;
        // Playback mute is the control that always works. Where the browser
        // can select an output, also return to the default device. A failure
        // must not end or mute the call.
        if (!speakerOutputSupported(el)) return;
        try {
          const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
          void withSink.setSinkId?.('')?.catch(() => {});
        } catch {
          // Unsupported or rejected — playback mute already applied.
        }
      };
      apply(remoteAudioRef.current);
      apply(remoteVideoRef.current);
      return next;
    });
  }, []);

  const switchCamera = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    void engine.switchCamera().then((res) => {
      if (!mountedRef.current) return;
      if (res === 'unsupported') {
        setCameraSwitchable(false); // hide the control gracefully
      } else if (res === 'failed') {
        toast.error('Could not switch camera', 'The camera may be in use by another app.');
      }
    });
  }, [toast]);

  /**
   * Outgoing echo arrived. Send held local ICE with the real id, then apply a
   * queued answer / callee ICE only when the ids match. UI stays Connecting
   * until the engine reports connected.
   */
  const flushHeldCallerSignals = async (callId: string) => {
    const gen = genRef.current;
    const call = activeCallRef.current;
    const local = pendingLocalIceRef.current;
    pendingLocalIceRef.current = [];
    if (call && socket) {
      for (const candidate of local) {
        socket.emit(EVENTS.CALL_ICE, {
          callId,
          from: user?.id ?? '',
          to: call.peerId,
          candidate
        });
      }
    }
    const early = outgoingEarlyIceRef.current;
    outgoingEarlyIceRef.current = [];
    const matchingIce = early.filter((item) => item.callId === callId);
    const engine = engineRef.current;
    // Queue callee ICE before the answer so applyAnswer flushes them with the
    // remote description. A non-matching id is discarded.
    for (const item of matchingIce) {
      if (engine) await engine.addRemoteCandidate(item.candidate);
      else pendingRemoteIceRef.current.push(item.candidate);
    }
    if (gen !== genRef.current) return;
    const queuedAnswer = pendingAnswerRef.current;
    pendingAnswerRef.current = null;
    if (queuedAnswer?.callId === callId && queuedAnswer.sdp && engine) {
      sounds().stopAll();
      await engine.applyAnswer(queuedAnswer.sdp);
      if (gen !== genRef.current) return;
      setActiveCall((prev) => {
        if (!prev || prev.state === 'CONNECTED') return prev;
        return { ...prev, state: 'CONNECTING' };
      });
    }
  };

  // ── Signaling listeners ──────────────────────────────────────────────────
  useSocketEvent<CallSignalPayload & { fromName?: string; fromUsername?: string; outgoing?: boolean }>(
    EVENTS.CALL_OFFER,
    (payload) => {
      if (payload.outgoing) {
        // Server echo with the authoritative call id. If this attempt was
        // already torn down, remember the id so a late end/reject cannot
        // hit the next call. If a reject arrived before this echo, apply it now.
        if (!activeCallRef.current) {
          concludedIdsRef.current = rememberConcludedId(concludedIdsRef.current, payload.callId);
          earlyTerminalRef.current = null;
          pendingAnswerRef.current = null;
          pendingLocalIceRef.current = [];
          outgoingEarlyIceRef.current = [];
          return;
        }
        if (concludedIdsRef.current.includes(payload.callId)) {
          if (pendingAnswerRef.current?.callId === payload.callId) pendingAnswerRef.current = null;
          outgoingEarlyIceRef.current = outgoingEarlyIceRef.current.filter((item) => item.callId !== payload.callId);
          return;
        }
        const early = earlyTerminalRef.current;
        if (early && early.callId === payload.callId) {
          earlyTerminalRef.current = null;
          authoritativeCallIdRef.current = payload.callId;
          finishCallRef.current(early.reason, payload.callId);
          return;
        }
        earlyTerminalRef.current = null;
        // Synchronous: the answer/ICE can be handled before React re-renders.
        authoritativeCallIdRef.current = payload.callId;
        const echoed = { ...activeCallRef.current, callId: payload.callId };
        latchedCallRef.current = echoed;
        activeCallRef.current = echoed;
        setActiveCall((prev) => (prev ? { ...prev, callId: payload.callId } : prev));
        void flushHeldCallerSignals(payload.callId);
        return;
      }
      if (activeCallRef.current) return; // defensive (server already blocks busy)
      earlyTerminalRef.current = null;
      authoritativeCallIdRef.current = null;
      pendingLocalIceRef.current = [];
      pendingAnswerRef.current = null;
      outgoingEarlyIceRef.current = [];
      dismissTerminal();
      sounds().resumeOnGesture().catch(() => {});
      pendingOfferRef.current = payload;
      const heldIce = preOfferIceRef.current.filter((item) => item.callId === payload.callId);
      preOfferIceRef.current = [];
      pendingRemoteIceRef.current = heldIce.map((item) => item.candidate);
      const incoming: ActiveCall = {
        callId: payload.callId,
        peerId: payload.from,
        peerName: payload.fromName ?? 'Incoming call',
        peerUsername: payload.fromUsername ?? '',
        peerAvatar: null,
        type: payload.type,
        direction: 'INCOMING',
        state: 'RINGING'
      };
      latchedCallRef.current = incoming;
      activeCallRef.current = incoming;
      setActiveCall(incoming);
      sounds().startRingtone();
    }
  );

  useSocketEvent<{ callId: string; sdp: RTCSessionDescriptionInit | null; accepted?: boolean }>(
    EVENTS.CALL_ANSWER,
    async (payload) => {
      const call = activeCallRef.current;
      // Answer can beat the outgoing echo. Hold it and apply only if that echo
      // names the same id — never attach an arbitrary id to pending-*.
      if (
        call?.direction === 'OUTGOING' &&
        call.callId.startsWith('pending-') &&
        !authoritativeCallIdRef.current &&
        payload?.callId &&
        !concludedIdsRef.current.includes(payload.callId)
      ) {
        pendingAnswerRef.current = { callId: payload.callId, sdp: payload.sdp ?? null };
        return;
      }
      if (!call || !eventMatchesActive(payload.callId)) return;
      if (call.direction === 'INCOMING') {
        // Echo of our own accept — stay on Connecting until the engine reports
        // connected. Duration must not start before media is up.
        setActiveCall((prev) => {
          if (!prev || prev.state === 'CONNECTED') return prev;
          return { ...prev, state: 'CONNECTING' };
        });
        return;
      }
      const engine = engineRef.current;
      if (!engine || !payload.sdp) return;
      const gen = genRef.current;
      sounds().stopAll(); // ringback off — the callee picked up
      await engine.applyAnswer(payload.sdp);
      if (gen !== genRef.current) return;
      // Connecting until onStateChange('connected'). If the engine already
      // flipped us to CONNECTED during applyAnswer, do not regress.
      setActiveCall((prev) => {
        if (!prev || prev.state === 'CONNECTED') return prev;
        return { ...prev, state: 'CONNECTING' };
      });
    }
  );

  useSocketEvent<{ callId: string; sdp?: RTCSessionDescriptionInit | null }>(EVENTS.CALL_RENEGOTIATE, async (payload) => {
    const call = activeCallRef.current;
    if (!call || !payload?.sdp || !eventMatchesActive(payload.callId)) return;
    const engine = engineRef.current;
    if (!engine) return;
    const gen = genRef.current;
    if (payload.sdp.type === 'offer') {
      const answer = await engine.acceptIceRestart(payload.sdp);
      const current = activeCallRef.current;
      const signalId = outboundCallId(current?.callId);
      if (gen !== genRef.current || !answer || !current || !signalId || !socket) return;
      socket.emit(EVENTS.CALL_RENEGOTIATE, { callId: signalId, to: current.peerId, sdp: answer });
      return;
    }
    if (payload.sdp.type === 'answer') {
      await engine.completeIceRestart(payload.sdp);
    }
  });

  useSocketEvent<{ callId?: string; candidate: RTCIceCandidateInit | null }>(EVENTS.CALL_ICE, async (payload) => {
    if (!payload?.candidate) return;
    const call = activeCallRef.current;
    if (!call && payload.callId && !concludedIdsRef.current.includes(payload.callId)) {
      if (preOfferIceRef.current.length < 64) {
        preOfferIceRef.current.push({ callId: payload.callId, candidate: payload.candidate });
      }
      return;
    }
    if (
      call?.direction === 'OUTGOING' &&
      call.callId.startsWith('pending-') &&
      !authoritativeCallIdRef.current &&
      payload.callId &&
      !concludedIdsRef.current.includes(payload.callId)
    ) {
      outgoingEarlyIceRef.current.push({ callId: payload.callId, candidate: payload.candidate });
      return;
    }
    if (payload.callId && !eventMatchesActive(payload.callId)) return;
    const engine = engineRef.current;
    if (engine) {
      await engine.addRemoteCandidate(payload.candidate);
    } else {
      // Callee has not accepted yet — queue until the engine exists.
      pendingRemoteIceRef.current.push(payload.candidate);
    }
  });

  useSocketEvent<{ callId: string }>(EVENTS.CALL_REJECT, (payload) => {
    const call = activeCallRef.current;
    if (!call) return;
    if (call.callId.startsWith('pending-') && payload?.callId && payload.callId !== call.callId) {
      if (!concludedIdsRef.current.includes(payload.callId)) {
        earlyTerminalRef.current = { callId: payload.callId, reason: 'REJECTED' };
      }
      return;
    }
    if (!eventMatchesActive(payload?.callId)) return;
    finishCallRef.current('REJECTED', payload?.callId);
  });

  useSocketEvent<{ callId: string; durationSec: number; reason?: string }>(EVENTS.CALL_END, (payload) => {
    const call = activeCallRef.current;
    if (!call) return;
    const reason = payload?.reason;
    const terminal: CallTerminalReason =
      reason === 'TIMEOUT'
        ? 'TIMEOUT'
        : reason === 'CANCELLED'
          ? 'CANCELLED'
          : reason === 'DISCONNECTED'
            ? 'DISCONNECTED'
            : 'ENDED';
    if (call.callId.startsWith('pending-') && payload?.callId && payload.callId !== call.callId) {
      if (!concludedIdsRef.current.includes(payload.callId)) {
        earlyTerminalRef.current = { callId: payload.callId, reason: terminal };
      }
      return;
    }
    if (!eventMatchesActive(payload?.callId)) return;
    finishCallRef.current(terminal, payload?.callId);
  });

  useSocketEvent<{ callId?: string | null; reason?: string }>(EVENTS.CALL_BUSY, (payload) => {
    if (!eventMatchesActive(payload?.callId, true)) return;
    finishCallRef.current('BUSY', payload?.callId);
  });

  // Phase 4C: the peer toggled their camera — show/hide the camera-off
  // placeholder instead of a frozen/black video.
  useSocketEvent<{ callId: string; videoEnabled?: boolean }>(EVENTS.CALL_CAMERA, (payload) => {
    const call = activeCallRef.current;
    if (!call || (payload?.callId && !eventMatchesActive(payload.callId))) return; // stale call
    setRemoteCameraOff(payload?.videoEnabled !== true);
  });

  // Diagnostics hook (used by the real-browser voice E2E to read WebRTC
  // stats — e.g. to verify actual audio RTP flow between two clients).
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__LINKUP_CALL__ = {
      getStats: () => engineRef.current?.getStats() ?? Promise.resolve([]),
      getLocalStream: () => engineRef.current?.getLocalStream() ?? null,
      getRemoteStream: () => engineRef.current?.getRemoteStream() ?? null,
      getDiagnostics: () => engineRef.current?.getDiagnostics() ?? null
    };
  }, []);

  // Centralized call-state phase (derived, never stored — the phase and the
  // underlying call cannot drift apart).
  const phase = deriveCallPhase({
    direction: activeCall?.direction ?? null,
    callState: activeCall?.state ?? null,
    issue: !!activeCall?.issue,
    reconnecting
  });
  const obviousState = terminal
    ? terminal.state
    : obviousCallState({
        direction: activeCall?.direction ?? null,
        callState: activeCall?.state ?? null,
        issue: !!activeCall?.issue,
        reconnecting,
        callingOnly: !!activeCall?.callId.startsWith('pending-')
      });

  const value = useMemo<CallContextValue>(
    () => ({
      activeCall,
      muted,
      cameraOff,
      micPermission,
      audioBlocked,
      startCall: (peer, type) => void startCall(peer, type),
      acceptCall: () => void acceptCall(),
      rejectCall,
      endCall,
      toggleMute,
      toggleCamera,
      resumeAudio,
      closeIssue,
      phase,
      obviousState,
      reconnecting,
      speakerOff,
      toggleSpeaker,
      cameraSwitchable,
      switchCamera
    }),
    [activeCall, muted, cameraOff, micPermission, audioBlocked, phase, obviousState, reconnecting, speakerOff, cameraSwitchable, startCall, acceptCall, rejectCall, endCall, toggleMute, toggleCamera, resumeAudio, closeIssue, toggleSpeaker, switchCamera]
  );

  const issue = activeCall?.issue ?? null;

  return (
    <CallContext.Provider value={value}>
      {children}

      {/* Incoming / outgoing call overlay (existing structure, voice-first) */}
      {activeCall && (
        <div
          className={cn(
            'fixed inset-0 z-[190] flex flex-col items-center justify-center p-6 text-white',
            activeCall.type === 'VIDEO' && activeCall.state === 'CONNECTED'
              ? 'bg-black'
              : 'bg-brand-gradient'
          )}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          aria-label={activeCall.direction === 'INCOMING' ? 'Incoming call' : 'Ongoing call'}
          data-call-state={obviousState}
        >
          {/* Remote media (Phase 4C: video calls) */}
          {activeCall.type === 'VIDEO' && (
            <>
              <video
                ref={remoteVideoRef}
                data-testid="remote-video"
                autoPlay
                playsInline
                className={cn(
                  'absolute inset-0 h-full w-full object-cover transition-opacity',
                  activeCall.state === 'CONNECTED' && !remoteCameraOff ? 'opacity-100' : 'opacity-0'
                )}
              />
              {/* Local preview (picture-in-picture); placeholder when the
                  camera is off — the microphone keeps streaming regardless. */}
              <div
                className={cn(
                  'absolute z-10 h-40 w-28 touch-none overflow-hidden rounded-2xl border border-white/20 bg-black/70 shadow-pop',
                  previewOffset
                    ? ''
                    : 'bottom-[max(8.5rem,calc(env(safe-area-inset-bottom)+7rem))] right-[max(1.25rem,env(safe-area-inset-right))]'
                )}
                style={previewOffset ? { left: previewOffset.x, top: previewOffset.y } : undefined}
                aria-label="Local video preview"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  previewDragRef.current = {
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    originX: rect.left,
                    originY: rect.top
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const drag = previewDragRef.current;
                  if (!drag || drag.pointerId !== e.pointerId) return;
                  setPreviewOffset(
                    clampPreviewPosition(
                      {
                        x: drag.originX + (e.clientX - drag.startX),
                        y: drag.originY + (e.clientY - drag.startY)
                      },
                      { width: window.innerWidth, height: window.innerHeight },
                      { width: e.currentTarget.offsetWidth, height: e.currentTarget.offsetHeight }
                    )
                  );
                }}
                onPointerUp={(e) => {
                  if (previewDragRef.current?.pointerId === e.pointerId) previewDragRef.current = null;
                }}
                onPointerCancel={(e) => {
                  if (previewDragRef.current?.pointerId === e.pointerId) previewDragRef.current = null;
                }}
              >
                <video
                  ref={localVideoRef}
                  data-testid="local-video"
                  autoPlay
                  playsInline
                  muted
                  className={cn('h-full w-full object-cover', cameraOff && 'invisible')}
                />
                {cameraOff && (
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/85"
                    data-testid="camera-off-placeholder"
                  >
                    <Avatar name={user?.displayName ?? 'Me'} size="sm" />
                    <VideoOff className="h-5 w-5" aria-hidden />
                    <span className="text-[10px] font-medium text-white/70">Camera off</span>
                  </div>
                )}
              </div>
            </>
          )}
          {/* Voice: dedicated remote audio element (playsInline for iOS) */}
          <audio ref={remoteAudioRef} autoPlay playsInline aria-hidden />

          {/* While remote video is showing, collapse the center block into a
              compact top pill so the video is not covered. */}
          {activeCall.type === 'VIDEO' && activeCall.state === 'CONNECTED' && !remoteCameraOff && !issue ? (
            <div className="absolute top-[max(1.5rem,env(safe-area-inset-top))] flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm">
              <span>{activeCall.peerName}</span>
              <span className="text-white/80">{obviousStateLabel(obviousState)}</span>
              <span className="text-white/70" data-testid="call-status">
                · {formatDuration(elapsed)}
              </span>
              {networkQualityLabel(networkQuality) ? (
                <span className="text-white/60" data-testid="call-network">
                  · {networkQualityLabel(networkQuality)}
                </span>
              ) : null}
            </div>
          ) : (
          <div className="relative flex flex-col items-center gap-4 text-center">
            <div className="relative">
              {activeCall.state === 'RINGING' && !issue && (
                <span className="absolute inset-0 rounded-full border-2 border-white/40 animate-ring-expand" aria-hidden />
              )}
              <Avatar name={activeCall.peerName} src={activeCall.peerAvatar} size="2xl" className="ring-4 ring-white/25" />
            </div>
            <div>
              {!issue && (
                <span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white/90">
                  {activeCall.type === 'VIDEO' ? (
                    <Video className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Phone className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {activeCall.type === 'VIDEO' ? 'Video call' : 'Voice call'}
                  <span className="text-white/70">· {obviousStateLabel(obviousState)}</span>
                </span>
              )}
              <h2 className="text-2xl font-extrabold">{activeCall.peerName}</h2>
              {activeCall.peerUsername ? (
                <p className="text-sm text-white/70">@{activeCall.peerUsername}</p>
              ) : null}
              <p className="mt-1.5 text-white/85" data-testid="call-status">
                {describeCallStatus({
                  direction: activeCall.direction,
                  callState: activeCall.state,
                  type: activeCall.type,
                  elapsedSec: elapsed,
                  callingOnly: activeCall.callId.startsWith('pending-'),
                  issue,
                  reconnecting
                })}
              </p>
              {activeCall.direction === 'INCOMING' &&
                activeCall.state === 'RINGING' &&
                activeCall.type === 'VIDEO' &&
                !issue && (
                  <p className="mx-auto mt-2 max-w-xs text-sm text-white/75">
                    Accepting uses your camera and microphone.
                  </p>
                )}
              {activeCall.state === 'CONNECTED' && networkQualityLabel(networkQuality) && (
                <p className="mt-2 text-xs font-medium text-white/70" data-testid="call-network">
                  {networkQualityLabel(networkQuality)}
                </p>
              )}
              {activeCall.type === 'VIDEO' && activeCall.state === 'CONNECTED' && remoteCameraOff && !issue && (
                <p
                  className="mx-auto mt-3 flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm text-white/90"
                  data-testid="remote-camera-off"
                >
                  <VideoOff className="h-4 w-4" aria-hidden />
                  {activeCall.peerName} turned their camera off
                </p>
              )}
              {issue && activeCall.issueMessage && (
                <p className="mx-auto mt-3 max-w-sm rounded-2xl bg-white/15 px-4 py-3 text-sm text-white/95" data-testid="call-issue-message">
                  {activeCall.issueMessage}
                </p>
              )}
            </div>
          </div>
          )}

          <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {(muted || speakerOff || (cameraOff && activeCall.type === 'VIDEO')) && !issue && (
              <div className="flex max-w-full flex-wrap justify-center gap-2" aria-live="polite">
                {muted && (
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink">Microphone muted</span>
                )}
                {speakerOff && (
                  <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white">Speaker muted</span>
                )}
                {cameraOff && activeCall.type === 'VIDEO' && (
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink">Camera off</span>
                )}
              </div>
            )}
            <div className="flex max-w-full flex-wrap items-center justify-center gap-3">
            {issue ? (
              <button
                type="button"
                ref={primaryActionRef}
                onClick={closeIssue}
                className="rounded-full bg-white px-8 py-3 font-semibold text-ink shadow-pop transition-transform outline-none hover:scale-105 focus-visible:ring-4 focus-visible:ring-white/50"
                aria-label="Close call dialog"
              >
                Close
              </button>
            ) : activeCall.direction === 'INCOMING' && activeCall.state === 'RINGING' ? (
              <>
                <button
                  type="button"
                  onClick={rejectCall}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-coral-500 text-white shadow-pop transition-transform outline-none hover:scale-105 focus-visible:ring-4 focus-visible:ring-white/50"
                  aria-label="Decline call"
                >
                  <PhoneOff className="h-7 w-7" />
                </button>
                <button
                  type="button"
                  ref={primaryActionRef}
                  onClick={acceptCall}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-mint-500 text-white shadow-pop transition-transform outline-none hover:scale-105 focus-visible:ring-4 focus-visible:ring-white/50"
                  aria-label="Accept call"
                >
                  <Phone className="h-7 w-7" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-pressed={muted}
                  className={cn(
                    'flex h-14 w-14 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-4 focus-visible:ring-white/50',
                    muted ? 'bg-white text-ink' : 'bg-white/15 text-white hover:bg-white/25'
                  )}
                  aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
                </button>
                <button
                  type="button"
                  onClick={toggleSpeaker}
                  aria-pressed={speakerOff}
                  className={cn(
                    'flex h-14 w-14 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-4 focus-visible:ring-white/50',
                    speakerOff ? 'bg-white text-ink' : 'bg-white/15 text-white hover:bg-white/25'
                  )}
                  aria-label={speakerOff ? 'Unmute speaker' : 'Mute speaker'}
                >
                  {speakerOff ? <VolumeX className="h-6 w-6" /> : <Volume2 className="h-6 w-6" />}
                </button>
                {activeCall.type === 'VIDEO' && (
                  <button
                    type="button"
                    onClick={toggleCamera}
                    aria-pressed={cameraOff}
                    className={cn(
                      'flex h-14 w-14 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-4 focus-visible:ring-white/50',
                      cameraOff ? 'bg-white text-ink' : 'bg-white/15 text-white hover:bg-white/25'
                    )}
                    aria-label={cameraOff ? 'Turn camera on' : 'Turn camera off'}
                  >
                    {cameraOff ? <VideoOff className="h-6 w-6" /> : <Video className="h-6 w-6" />}
                  </button>
                )}
                {activeCall.type === 'VIDEO' && cameraSwitchable && (
                  <button
                    type="button"
                    onClick={switchCamera}
                    className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15 text-white transition-colors outline-none hover:bg-white/25 focus-visible:ring-4 focus-visible:ring-white/50"
                    aria-label="Switch camera"
                  >
                    <SwitchCamera className="h-6 w-6" />
                  </button>
                )}
                <button
                  type="button"
                  ref={primaryActionRef}
                  onClick={endCall}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-coral-500 text-white shadow-pop transition-transform outline-none hover:scale-105 focus-visible:ring-4 focus-visible:ring-white/50"
                  aria-label="End call"
                >
                  <PhoneOff className="h-7 w-7" />
                </button>
              </>
            )}
            </div>
          </div>

          {audioBlocked && !issue && (
            <button
              type="button"
              onClick={resumeAudio}
              className="absolute bottom-[max(7.5rem,calc(env(safe-area-inset-bottom)+6rem))] rounded-full bg-white/20 px-5 py-2 text-sm font-medium text-white outline-none hover:bg-white/30 focus-visible:ring-4 focus-visible:ring-white/50"
              aria-label="Enable call audio"
            >
              🔊 Tap to enable audio
            </button>
          )}
        </div>
      )}

      {/* Terminal state after media is released. Not the live-call dialog —
          aria-label and test id stay off the browser-test contract so the
          overlay is already gone, and this card dismisses itself. */}
      {terminal && !activeCall && (
        <div
          className="fixed inset-x-0 bottom-6 z-[180] mx-auto flex w-[min(100%-2rem,24rem)] items-center justify-between gap-3 rounded-2xl bg-ink px-4 py-3 text-white shadow-pop"
          role="status"
          aria-live="polite"
          aria-label={terminal.title}
          data-call-state={terminal.state}
        >
          <div className="min-w-0 text-left">
            <p className="text-sm font-semibold">{terminal.title}</p>
            {terminal.detail ? <p className="text-xs text-white/75">{terminal.detail}</p> : null}
            {terminal.peerName ? <p className="truncate text-xs text-white/60">{terminal.peerName}</p> : null}
          </div>
          <button
            type="button"
            onClick={dismissTerminal}
            className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white outline-none hover:bg-white/25 focus-visible:ring-4 focus-visible:ring-white/50"
            aria-label="Dismiss call result"
          >
            Close
          </button>
        </div>
      )}
    </CallContext.Provider>
  );
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used within CallProvider');
  return ctx;
}
