'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Mic, MicOff, Phone, PhoneOff, SwitchCamera, Video, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { EVENTS } from '@shared/events';
import { useAuth } from './AuthProvider';
import { useSocket, useSocketEvent } from './SocketProvider';
import { useCall } from './CallProvider';
import { Avatar } from '@/components/ui/Avatar';
import { useToast } from '@/components/ui/Toast';
import { cn, formatDuration } from '@/lib/utils';
import { CallEngine, type EngineState } from '@/lib/call-engine';
import { connectedElapsedSeconds, listCameraDeviceIds, mediaIssueMessage, speakerOutputSupported } from '@/lib/call-phase';
import { meshShouldOffer } from '@/lib/group-call-state';
import { callLockHolder, claimCallLock, releaseCallLock } from '@/lib/call-lock';

/**
 * Small-group mesh. Each remote participant gets one CallEngine (one peer
 * connection). There is no media server — the cap of 4 is enforced on the
 * server, and this screen does not pretend otherwise.
 */

type Person = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  muted?: boolean;
  cameraOff?: boolean;
};

type Session = {
  callId: string;
  conversationId: string;
  type: 'VOICE' | 'VIDEO';
  groupTitle: string;
  groupAvatar: string | null;
  host: Person;
  direction: 'INCOMING' | 'OUTGOING';
  phase: 'ringing' | 'connecting' | 'connected';
  issue: string | null;
};

type PeerTile = Person & { stream: MediaStream | null; link: 'connecting' | 'connected' | 'down' };

type GroupCallContextValue = {
  startGroupCall: (args: {
    conversationId: string;
    type: 'VOICE' | 'VIDEO';
    inviteeIds?: string[];
  }) => void;
  active: boolean;
};

const GroupCallContext = createContext<GroupCallContextValue | null>(null);

export function useGroupCall() {
  const ctx = useContext(GroupCallContext);
  if (!ctx) throw new Error('useGroupCall must be used within GroupCallProvider');
  return ctx;
}

const FALLBACK_RTC: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};

async function fetchRtcConfig(): Promise<RTCConfiguration> {
  try {
    const res = await fetch('/api/calls/ice', { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return FALLBACK_RTC;
    const body = (await res.json()) as { data?: { iceServers?: unknown } };
    const servers = body.data?.iceServers;
    if (Array.isArray(servers) && servers.length > 0) return { iceServers: servers as RTCIceServer[] };
    return FALLBACK_RTC;
  } catch {
    return FALLBACK_RTC;
  }
}

function applySink(el: HTMLMediaElement | null, muted: boolean) {
  if (!el) return;
  el.muted = muted;
  if (muted || !speakerOutputSupported(el)) return;
  try {
    const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
    void withSink.setSinkId?.('')?.catch(() => {});
  } catch {
    // Playback mute already applied.
  }
}

export function GroupCallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { socket, connected } = useSocket();
  const { activeCall } = useCall();
  const toast = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [peers, setPeers] = useState<PeerTile[]>([]);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [speakerOff, setSpeakerOff] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [cameraSwitchable, setCameraSwitchable] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  const enginesRef = useRef<Map<string, CallEngine>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteEls = useRef<Map<string, HTMLVideoElement>>(new Map());
  const rtcRef = useRef<RTCConfiguration>(FALLBACK_RTC);
  const mountedRef = useRef(true);
  const actingRef = useRef(false);
  const joinedRef = useRef(false);
  const connectedAtRef = useRef(0);
  const restartRef = useRef<Set<string>>(new Set());
  const primaryRef = useRef<HTMLButtonElement>(null);
  sessionRef.current = session;

  const stopShared = () => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
  };

  const dropEngines = () => {
    for (const engine of enginesRef.current.values()) engine.dispose({ stopLocalTracks: false });
    enginesRef.current.clear();
    restartRef.current.clear();
  };

  const clearSession = useCallback(() => {
    dropEngines();
    stopShared();
    joinedRef.current = false;
    actingRef.current = false;
    connectedAtRef.current = 0;
    releaseCallLock('group');
    if (mountedRef.current) {
      setSession(null);
      setPeers([]);
      setMuted(false);
      setCameraOff(false);
      setSpeakerOff(false);
      setElapsed(0);
      setCameraSwitchable(false);
      setMediaReady(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      dropEngines();
      stopShared();
      releaseCallLock('group');
    };
  }, []);

  const acquire = useCallback(async (type: 'VOICE' | 'VIDEO') => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return null;
    const stream = await media.getUserMedia({
      audio: true,
      video: type === 'VIDEO' ? { facingMode: 'user' } : false
    });
    return stream;
  }, []);

  const sendSignal = useCallback(
    (to: string, kind: 'offer' | 'answer' | 'ice' | 'renegotiate', extra: Record<string, unknown>) => {
      const call = sessionRef.current;
      if (!call || !socket) return;
      socket.emit(EVENTS.GROUP_CALL_SIGNAL, { callId: call.callId, to, kind, ...extra });
    },
    [socket]
  );

  const attachEngine = useCallback(
    async (peer: Person, shouldOffer: boolean) => {
      const call = sessionRef.current;
      const stream = localStreamRef.current;
      if (!call || !stream || enginesRef.current.has(peer.id) || peer.id === user?.id) return;
      const engine = new CallEngine(
        {
          onIceCandidate: (candidate) => sendSignal(peer.id, 'ice', { candidate }),
          onRemoteStream: (remote) => {
            if (!mountedRef.current) return;
            setPeers((prev) => prev.map((p) => (p.id === peer.id ? { ...p, stream: remote } : p)));
          },
          onStateChange: (state: EngineState) => {
            if (!mountedRef.current) return;
            setPeers((prev) =>
              prev.map((p) =>
                p.id === peer.id
                  ? { ...p, link: state === 'connected' ? 'connected' : state === 'failed' ? 'down' : p.link }
                  : p
              )
            );
            if (state === 'connected') restartRef.current.delete(peer.id);
            if (state === 'disconnected' && user?.id && meshShouldOffer(user.id, peer.id) && !restartRef.current.has(peer.id)) {
              restartRef.current.add(peer.id);
              void engine.beginIceRestart().then((offer) => {
                if (offer) sendSignal(peer.id, 'renegotiate', { sdp: offer, renegotiateRole: 'offer' });
              });
            }
          },
          onRemoteTrackMuted: (kind, isMuted) => {
            if (!mountedRef.current || kind !== 'video') return;
            setPeers((prev) => prev.map((p) => (p.id === peer.id ? { ...p, cameraOff: isMuted } : p)));
          }
        },
        rtcRef.current
      );
      engine.adoptLocalStream(stream, call.type);
      enginesRef.current.set(peer.id, engine);
      if (shouldOffer) {
        const offer = await engine.createOffer();
        await engine.ensureVideoSender();
        if (offer) sendSignal(peer.id, 'offer', { sdp: offer });
      }
    },
    [sendSignal, user?.id]
  );

  const syncRoster = useCallback(
    (roster: Person[]) => {
      const mine = user?.id;
      if (!mine) return;
      const remote = roster.filter((p) => p.id !== mine);
      setPeers((prev) =>
        remote.map((p) => {
          const existing = prev.find((row) => row.id === p.id);
          return {
            ...p,
            stream: existing?.stream ?? null,
            link: existing?.link ?? 'connecting'
          };
        })
      );
      for (const gone of enginesRef.current.keys()) {
        if (!remote.some((p) => p.id === gone)) {
          enginesRef.current.get(gone)?.dispose({ stopLocalTracks: false });
          enginesRef.current.delete(gone);
        }
      }
      if (!joinedRef.current || !localStreamRef.current) return;
      for (const peer of remote) {
        void attachEngine(peer, meshShouldOffer(mine, peer.id));
      }
      if (remote.length >= 1 && !connectedAtRef.current) {
        connectedAtRef.current = Date.now();
        setSession((prev) => (prev ? { ...prev, phase: 'connected' } : prev));
      }
    },
    [attachEngine, user?.id]
  );

  const finishLocal = useCallback(
    (reason: 'leave' | 'end') => {
      const call = sessionRef.current;
      if (call && socket) {
        socket.emit(reason === 'end' ? EVENTS.GROUP_CALL_END : EVENTS.GROUP_CALL_LEAVE, { callId: call.callId });
      }
      clearSession();
    },
    [clearSession, socket]
  );

  const accept = useCallback(async () => {
    const call = sessionRef.current;
    if (!call || actingRef.current || call.direction !== 'INCOMING') return;
    if (activeCall || !claimCallLock('group')) {
      toast.info('Already in a call');
      return;
    }
    actingRef.current = true;
    try {
      rtcRef.current = await fetchRtcConfig();
      const stream = await acquire(call.type);
      if (!mountedRef.current || sessionRef.current?.callId !== call.callId) {
        stream?.getTracks().forEach((t) => t.stop());
        releaseCallLock('group');
        return;
      }
      if (!stream) {
        socket?.emit(EVENTS.GROUP_CALL_DECLINE, { callId: call.callId });
        setSession((prev) =>
          prev
            ? { ...prev, issue: mediaIssueMessage('PERMISSION_DENIED', call.type, 'INCOMING') }
            : prev
        );
        releaseCallLock('group');
        return;
      }
      localStreamRef.current = stream;
      joinedRef.current = true;
      setMediaReady(true);
      if (call.type === 'VIDEO') {
        const ids = await listCameraDeviceIds().catch(() => []);
        if (mountedRef.current) setCameraSwitchable(ids.length >= 2);
      }
      setSession((prev) => (prev ? { ...prev, phase: 'connecting', issue: null } : prev));
      socket?.emit(EVENTS.GROUP_CALL_ACCEPT, { callId: call.callId });
    } catch {
      socket?.emit(EVENTS.GROUP_CALL_DECLINE, { callId: call.callId });
      setSession((prev) =>
        prev ? { ...prev, issue: mediaIssueMessage('MEDIA_ERROR', call.type, 'INCOMING') } : prev
      );
      releaseCallLock('group');
    } finally {
      actingRef.current = false;
    }
  }, [acquire, activeCall, socket, toast]);

  const startGroupCall = useCallback(
    (args: { conversationId: string; type: 'VOICE' | 'VIDEO'; inviteeIds?: string[] }) => {
      if (sessionRef.current || activeCall || !claimCallLock('group')) {
        toast.info('Already in a call');
        return;
      }
      if (!socket) {
        releaseCallLock('group');
        toast.error('Call unavailable', 'You are not connected. Try again in a moment.');
        return;
      }
      socket.emit(EVENTS.GROUP_CALL_START, {
        conversationId: args.conversationId,
        type: args.type,
        inviteeIds: args.inviteeIds
      });
    },
    [activeCall, socket, toast]
  );

  useSocketEvent(EVENTS.GROUP_CALL_ERROR, (payload: { code?: string; message?: string }) => {
    if (payload?.code === 'ENDED') {
      clearSession();
      return;
    }
    toast.error('Call unavailable', payload?.message || 'The group call could not be started.');
    if (!joinedRef.current) clearSession();
  });

  useSocketEvent(EVENTS.GROUP_CALL_BUSY, () => {
    toast.info('Already in a call');
    if (!joinedRef.current) clearSession();
  });

  useSocketEvent(
    EVENTS.GROUP_CALL_STARTED,
    async (payload: {
      callId: string;
      conversationId: string;
      type: 'VOICE' | 'VIDEO';
      groupTitle?: string | null;
      groupAvatar?: string | null;
      host: Person;
    }) => {
      if (!payload?.callId || payload.host?.id !== user?.id) return;
      const next: Session = {
        callId: payload.callId,
        conversationId: payload.conversationId,
        type: payload.type,
        groupTitle: payload.groupTitle || 'Group call',
        groupAvatar: payload.groupAvatar ?? null,
        host: payload.host,
        direction: 'OUTGOING',
        phase: 'ringing',
        issue: null
      };
      sessionRef.current = next;
      setSession(next);
      try {
        rtcRef.current = await fetchRtcConfig();
        const stream = await acquire(payload.type);
        if (sessionRef.current?.callId !== payload.callId) {
          stream?.getTracks().forEach((t) => t.stop());
          return;
        }
        if (!stream) {
          socket?.emit(EVENTS.GROUP_CALL_END, { callId: payload.callId });
          setSession((prev) =>
            prev ? { ...prev, issue: mediaIssueMessage('PERMISSION_DENIED', payload.type, 'OUTGOING') } : prev
          );
          return;
        }
        localStreamRef.current = stream;
        joinedRef.current = true;
        setMediaReady(true);
        if (payload.type === 'VIDEO') {
          const ids = await listCameraDeviceIds().catch(() => []);
          if (mountedRef.current) setCameraSwitchable(ids.length >= 2);
        }
      } catch {
        socket?.emit(EVENTS.GROUP_CALL_END, { callId: payload.callId });
        setSession((prev) =>
          prev ? { ...prev, issue: mediaIssueMessage('MEDIA_ERROR', payload.type, 'OUTGOING') } : prev
        );
      }
    }
  );

  useSocketEvent(
    EVENTS.GROUP_CALL_INVITE,
    (payload: {
      callId: string;
      conversationId: string;
      type: 'VOICE' | 'VIDEO';
      groupTitle?: string | null;
      groupAvatar?: string | null;
      host: Person;
    }) => {
      if (!payload?.callId || !payload.host) return;
      if (sessionRef.current || activeCall || callLockHolder()) {
        socket?.emit(EVENTS.GROUP_CALL_DECLINE, { callId: payload.callId });
        return;
      }
      setSession({
        callId: payload.callId,
        conversationId: payload.conversationId,
        type: payload.type,
        groupTitle: payload.groupTitle || 'Group call',
        groupAvatar: payload.groupAvatar ?? null,
        host: payload.host,
        direction: 'INCOMING',
        phase: 'ringing',
        issue: null
      });
    }
  );

  useSocketEvent(EVENTS.GROUP_CALL_JOINED, (payload: { callId: string; userId?: string; roster?: Person[] }) => {
    if (!payload?.callId || payload.callId !== sessionRef.current?.callId) return;
    if (payload.userId === user?.id) {
      for (const engine of enginesRef.current.values()) engine.dispose({ stopLocalTracks: false });
      enginesRef.current.clear();
    }
    joinedRef.current = true;
    syncRoster(payload.roster ?? []);
  });

  useSocketEvent(EVENTS.GROUP_CALL_PEER, (payload: { callId: string; userId: string; phase: string }) => {
    if (payload?.callId !== sessionRef.current?.callId) return;
    enginesRef.current.get(payload.userId)?.dispose({ stopLocalTracks: false });
    enginesRef.current.delete(payload.userId);
    setPeers((prev) => prev.filter((p) => p.id !== payload.userId));
  });

  useSocketEvent(EVENTS.GROUP_CALL_STATE, (payload: { callId: string; from: string; muted?: boolean; cameraOff?: boolean }) => {
    if (payload?.callId !== sessionRef.current?.callId) return;
    setPeers((prev) =>
      prev.map((p) =>
        p.id === payload.from ? { ...p, muted: payload.muted ?? p.muted, cameraOff: payload.cameraOff ?? p.cameraOff } : p
      )
    );
  });

  useSocketEvent(
    EVENTS.GROUP_CALL_SIGNAL,
    async (payload: {
      callId: string;
      from: string;
      kind: string;
      sdp?: RTCSessionDescriptionInit | null;
      candidate?: RTCIceCandidateInit | null;
      renegotiateRole?: string;
    }) => {
      const call = sessionRef.current;
      if (!call || payload?.callId !== call.callId || !payload.from || !localStreamRef.current) return;
      let engine = enginesRef.current.get(payload.from);
      if (!engine && (payload.kind === 'offer' || payload.kind === 'renegotiate')) {
        const known = peers.find((p) => p.id === payload.from);
        await attachEngine(
          known ?? { id: payload.from, username: '', displayName: 'Participant', avatarUrl: null },
          false
        );
        engine = enginesRef.current.get(payload.from);
      }
      if (!engine) return;
      if (payload.kind === 'offer' && payload.sdp) {
        const answer = await engine.acceptOffer(payload.sdp);
        await engine.ensureVideoSender();
        if (answer) sendSignal(payload.from, 'answer', { sdp: answer });
      } else if (payload.kind === 'answer' && payload.sdp) {
        await engine.applyAnswer(payload.sdp);
      } else if (payload.kind === 'ice') {
        await engine.addRemoteCandidate(payload.candidate);
      } else if (payload.kind === 'renegotiate' && payload.sdp) {
        if (payload.renegotiateRole === 'answer') {
          await engine.completeIceRestart(payload.sdp);
        } else {
          const answer = await engine.acceptIceRestart(payload.sdp);
          if (answer) sendSignal(payload.from, 'renegotiate', { sdp: answer, renegotiateRole: 'answer' });
        }
      }
    }
  );

  useSocketEvent(EVENTS.GROUP_CALL_ENDED, (payload: { callId?: string }) => {
    if (!sessionRef.current || (payload?.callId && payload.callId !== sessionRef.current.callId)) return;
    clearSession();
    toast.info('Call ended');
  });

  useEffect(() => {
    if (!connected || !sessionRef.current || !joinedRef.current) return;
    socket?.emit(EVENTS.GROUP_CALL_REJOIN, { callId: sessionRef.current.callId });
  }, [connected, socket]);

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [mediaReady, session?.type]);

  useEffect(() => {
    if (session?.phase !== 'connected') return;
    const t = setInterval(() => setElapsed(connectedElapsedSeconds(connectedAtRef.current, Date.now())), 1000);
    return () => clearInterval(t);
  }, [session?.phase]);

  useEffect(() => {
    if (!session) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !sessionRef.current) return;
      e.preventDefault();
      if (sessionRef.current.issue) clearSession();
      else if (sessionRef.current.direction === 'INCOMING' && sessionRef.current.phase === 'ringing') {
        socket?.emit(EVENTS.GROUP_CALL_DECLINE, { callId: sessionRef.current.callId });
        clearSession();
      } else if (sessionRef.current.host.id === user?.id) finishLocal('end');
      else finishLocal('leave');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, clearSession, finishLocal, socket, user?.id]);

  useEffect(() => {
    for (const [id, el] of remoteEls.current) {
      if (peers.some((p) => p.id === id)) applySink(el, speakerOff);
    }
  }, [speakerOff, peers]);

  const toggleMute = () => {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
    if (session) socket?.emit(EVENTS.GROUP_CALL_STATE, { callId: session.callId, muted: next });
  };

  const toggleCamera = async () => {
    if (!session || session.type !== 'VIDEO' || !localStreamRef.current) return;
    const nextOff = !cameraOff;
    if (nextOff) {
      const track = localStreamRef.current.getVideoTracks()[0];
      for (const engine of enginesRef.current.values()) await engine.setOutboundVideoTrack(null);
      if (track) {
        localStreamRef.current.removeTrack(track);
        track.stop();
      }
    } else {
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        const track = fresh.getVideoTracks()[0];
        if (!track) return;
        localStreamRef.current.addTrack(track);
        for (const engine of enginesRef.current.values()) {
          engine.ensureVideoSender();
          await engine.setOutboundVideoTrack(track);
        }
        if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      } catch {
        toast.error('Camera unavailable', 'The call is still connected on voice.');
        return;
      }
    }
    setCameraOff(nextOff);
    socket?.emit(EVENTS.GROUP_CALL_STATE, { callId: session.callId, cameraOff: nextOff });
  };

  const switchCamera = async () => {
    if (!localStreamRef.current) return;
    const ids = await listCameraDeviceIds().catch(() => []);
    const current = localStreamRef.current.getVideoTracks()[0];
    const nextId = ids.find((id) => id !== current?.getSettings().deviceId) ?? ids[0];
    if (!nextId) {
      setCameraSwitchable(false);
      return;
    }
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: nextId } } });
      const track = fresh.getVideoTracks()[0];
      if (!track) return;
      if (current) {
        localStreamRef.current.removeTrack(current);
        current.stop();
      }
      localStreamRef.current.addTrack(track);
      for (const engine of enginesRef.current.values()) await engine.setOutboundVideoTrack(track);
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    } catch {
      toast.error('Could not switch camera');
    }
  };

  const value = { startGroupCall, active: !!session };

  return (
    <GroupCallContext.Provider value={value}>
      {children}
      {session && (
        <div
          className="fixed inset-0 z-[190] flex flex-col bg-brand-gradient text-white"
          role="dialog"
          aria-modal="true"
          aria-label={session.direction === 'INCOMING' && session.phase === 'ringing' ? 'Incoming group call' : 'Group call'}
        >
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 pt-[max(1.25rem,env(safe-area-inset-top))]">
            {session.phase === 'connected' && session.type === 'VIDEO' ? (
              <div className="grid w-full max-w-3xl flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                {peers.map((peer) => (
                  <div key={peer.id} className="relative min-h-40 overflow-hidden rounded-2xl bg-black/50">
                    <video
                      autoPlay
                      playsInline
                      ref={(el) => {
                        if (!el) {
                          remoteEls.current.delete(peer.id);
                          return;
                        }
                        remoteEls.current.set(peer.id, el);
                        if (peer.stream && el.srcObject !== peer.stream) el.srcObject = peer.stream;
                        applySink(el, speakerOff);
                      }}
                      className={cn('h-full w-full object-cover', peer.cameraOff || !peer.stream ? 'opacity-0' : 'opacity-100')}
                    />
                    {(peer.cameraOff || !peer.stream) && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                        <Avatar name={peer.displayName} src={peer.avatarUrl} size="lg" />
                        <p className="text-sm font-semibold">{peer.displayName}</p>
                      </div>
                    )}
                    <p className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2 py-0.5 text-xs">
                      {peer.displayName}
                      {peer.muted ? ' · muted' : ''}
                      {peer.link === 'down' ? ' · reconnecting' : ''}
                    </p>
                  </div>
                ))}
                {peers.length === 0 && <p className="text-sm text-white/80">Waiting for others to join…</p>}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center">
                <Avatar name={session.groupTitle} src={session.groupAvatar} size="2xl" />
                <p className="text-xs font-semibold uppercase tracking-wide text-white/70">
                  {session.type === 'VIDEO' ? 'Video call' : 'Voice call'} · Group
                </p>
                <h2 className="text-2xl font-extrabold">{session.groupTitle}</h2>
                <p className="text-sm text-white/80">
                  {session.direction === 'INCOMING' ? `${session.host.displayName} · @${session.host.username}` : 'Calling…'}
                </p>
                <p className="text-sm text-white/85">
                  {session.phase === 'connected'
                    ? `Group call · ${formatDuration(elapsed)}`
                    : session.phase === 'connecting'
                      ? 'Connecting…'
                      : session.direction === 'INCOMING'
                        ? 'Incoming group call'
                        : 'Ringing…'}
                </p>
                <p className="max-w-xs text-xs text-white/60">Direct connection · up to 4 people. No media server is configured.</p>
                {session.issue && <p className="max-w-sm rounded-2xl bg-white/15 px-4 py-3 text-sm">{session.issue}</p>}
              </div>
            )}
            {session.type === 'VIDEO' && joinedRef.current && (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="absolute bottom-[max(8.5rem,calc(env(safe-area-inset-bottom)+7rem))] right-[max(1rem,env(safe-area-inset-right))] z-10 h-36 w-24 rounded-2xl border border-white/20 bg-black/70 object-cover"
              />
            )}
          </div>

          <div className="flex flex-col items-center gap-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {(muted || speakerOff || (cameraOff && session.type === 'VIDEO')) && !session.issue && (
              <div className="flex max-w-full flex-wrap justify-center gap-2">
                {muted && <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink">Microphone muted</span>}
                {speakerOff && <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold">Speaker muted</span>}
                {cameraOff && session.type === 'VIDEO' && (
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink">Camera off</span>
                )}
              </div>
            )}
            <div className="flex max-w-full flex-wrap items-center justify-center gap-3">
              {session.issue ? (
                <button type="button" ref={primaryRef} className="rounded-full bg-white px-8 py-3 font-semibold text-ink" onClick={clearSession}>
                  Close
                </button>
              ) : session.direction === 'INCOMING' && session.phase === 'ringing' ? (
                <>
                  <button
                    type="button"
                    className="flex h-16 w-16 items-center justify-center rounded-full bg-coral-500"
                    aria-label="Decline group call"
                    onClick={() => {
                      socket?.emit(EVENTS.GROUP_CALL_DECLINE, { callId: session.callId });
                      clearSession();
                    }}
                  >
                    <PhoneOff className="h-7 w-7" />
                  </button>
                  <button
                    type="button"
                    ref={primaryRef}
                    className="flex h-16 w-16 items-center justify-center rounded-full bg-mint-500"
                    aria-label="Accept group call"
                    onClick={() => void accept()}
                  >
                    <Phone className="h-7 w-7" />
                  </button>
                </>
              ) : (
                <>
                  <button type="button" aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={muted} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15" onClick={toggleMute}>
                    {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
                  </button>
                  <button
                    type="button"
                    aria-label={speakerOff ? 'Unmute speaker' : 'Mute speaker'}
                    aria-pressed={speakerOff}
                    className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15"
                    onClick={() => setSpeakerOff((s) => !s)}
                  >
                    {speakerOff ? <VolumeX className="h-6 w-6" /> : <Volume2 className="h-6 w-6" />}
                  </button>
                  {session.type === 'VIDEO' && (
                    <button type="button" aria-label={cameraOff ? 'Turn camera on' : 'Turn camera off'} aria-pressed={cameraOff} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15" onClick={() => void toggleCamera()}>
                      {cameraOff ? <VideoOff className="h-6 w-6" /> : <Video className="h-6 w-6" />}
                    </button>
                  )}
                  {session.type === 'VIDEO' && cameraSwitchable && (
                    <button type="button" aria-label="Switch camera" className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15" onClick={() => void switchCamera()}>
                      <SwitchCamera className="h-6 w-6" />
                    </button>
                  )}
                  <button
                    type="button"
                    ref={primaryRef}
                    className="flex h-16 w-16 items-center justify-center rounded-full bg-coral-500"
                    aria-label={session.host.id === user?.id ? 'End group call' : 'Leave group call'}
                    onClick={() => finishLocal(session.host.id === user?.id ? 'end' : 'leave')}
                  >
                    <PhoneOff className="h-7 w-7" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </GroupCallContext.Provider>
  );
}
