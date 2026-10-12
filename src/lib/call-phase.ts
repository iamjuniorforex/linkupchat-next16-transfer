/**
 * Pure call-UI state helpers (Phase 14 Step 1).
 *
 * Centralizes the client-side call state machine and the small decision
 * helpers behind the call overlay, so the UI never builds states out of
 * scattered booleans and every transition is unit-testable without a DOM,
 * media devices, or a server. Wire contracts (Socket.IO events, engine
 * states) are untouched — this maps them to UI-facing states only.
 */

import { formatDuration } from './utils';

/**
 * The single source of truth for "where is this call right now".
 * Exactly one phase is active at a time — combinations that should be
 * impossible (e.g. "reconnecting while ringing") cannot be represented.
 */
export type CallPhase =
  | 'idle'
  | 'incoming'
  | 'outgoing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended';

export type CallIssueKind = 'PERMISSION_DENIED' | 'MEDIA_ERROR';

export type CallDirection = 'INCOMING' | 'OUTGOING';
export type CallState = 'RINGING' | 'CONNECTING' | 'CONNECTED';
export type CallKind = 'VOICE' | 'VIDEO';

export interface CallPhaseInput {
  direction: CallDirection | null;
  callState: CallState | null;
  /** A local media/permission issue is being shown — the call is terminal. */
  issue?: boolean;
  /** The peer connection dropped and the engine's grace window is running. */
  reconnecting?: boolean;
  /** The call just concluded (accept/decline/end) on its way back to idle. */
  concluded?: boolean;
}

export function deriveCallPhase(i: CallPhaseInput): CallPhase {
  if (i.concluded || i.issue) return 'ended';
  if (!i.direction || !i.callState) return 'idle';
  switch (i.callState) {
    case 'RINGING':
      return i.direction === 'INCOMING' ? 'incoming' : 'outgoing';
    case 'CONNECTING':
      // A drop while still connecting must not claim "reconnecting" yet.
      return 'connecting';
    case 'CONNECTED':
      return i.reconnecting ? 'reconnecting' : 'connected';
    default:
      return 'idle';
  }
}

/**
 * Spec vocabulary for the call screen. Kept separate from {@link CallPhase}
 * so existing phase consumers (incoming/outgoing/reconnecting) stay stable.
 * Permission/media issues are `failed` here; `deriveCallPhase` still reports
 * them as `ended` (terminal overlay, media already released).
 */
export type ObviousCallState =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'rejected'
  | 'missed'
  | 'failed';

export type TerminalCallState = 'ended' | 'rejected' | 'missed' | 'failed';

export function obviousCallState(
  i: CallPhaseInput & { callingOnly?: boolean; terminal?: TerminalCallState | null }
): ObviousCallState {
  if (i.terminal) return i.terminal;
  if (i.issue) return 'failed';
  if (i.concluded) return 'ended';
  const phase = deriveCallPhase(i);
  switch (phase) {
    case 'idle':
      return 'idle';
    case 'incoming':
      return 'ringing';
    case 'outgoing':
      return i.callingOnly ? 'calling' : 'ringing';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'connected':
      return 'connected';
    case 'ended':
      return 'ended';
    default:
      return 'idle';
  }
}

/** Short on-screen label for the obvious state. Never a raw error name. */
export function obviousStateLabel(state: ObviousCallState): string {
  switch (state) {
    case 'calling':
      return 'Calling';
    case 'ringing':
      return 'Ringing';
    case 'connecting':
      return 'Connecting';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting';
    case 'ended':
      return 'Ended';
    case 'rejected':
      return 'Declined';
    case 'missed':
      return 'Missed';
    case 'failed':
      return 'Failed';
    default:
      return 'Idle';
  }
}

export type CallTerminalReason =
  | 'ENDED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'DISCONNECTED'
  | 'BUSY'
  | 'FAILED'
  | 'LOCAL_END'
  | 'LOCAL_REJECT';

export interface CallTerminalOutcome {
  state: TerminalCallState;
  title: string;
  detail: string;
}

/** Map a conclusion reason to the ended / rejected / failed screen. */
export function classifyCallTerminal(
  reason: CallTerminalReason,
  direction: CallDirection
): CallTerminalOutcome {
  switch (reason) {
    case 'REJECTED':
      return {
        state: 'rejected',
        title: 'Call declined',
        detail: direction === 'OUTGOING' ? 'They declined the call.' : 'The call was declined.'
      };
    case 'LOCAL_REJECT':
      return {
        state: 'rejected',
        title: 'Call declined',
        detail: 'You declined the call.'
      };
    case 'BUSY':
      return {
        state: 'failed',
        title: 'Call failed',
        detail: 'They are already in another call.'
      };
    case 'FAILED':
    case 'DISCONNECTED':
      return {
        state: 'failed',
        title: 'Call failed',
        detail: 'The connection was lost.'
      };
    case 'TIMEOUT':
      return direction === 'INCOMING'
        ? { state: 'missed', title: 'Missed call', detail: 'You missed this call.' }
        : { state: 'ended', title: 'No answer', detail: 'They did not answer.' };
    case 'CANCELLED':
      return direction === 'INCOMING'
        ? { state: 'ended', title: 'Call cancelled', detail: 'The caller cancelled.' }
        : { state: 'ended', title: 'Call ended', detail: 'You cancelled the call.' };
    case 'LOCAL_END':
    case 'ENDED':
    default:
      return { state: 'ended', title: 'Call ended', detail: '' };
  }
}

const CONCLUDED_ID_LIMIT = 8;

/** Remember a real call id so a late signal cannot tear down the next call. */
export function rememberConcludedId(ids: readonly string[], callId: string | null | undefined): string[] {
  if (!callId || callId.startsWith('pending-')) return ids.slice();
  if (ids.includes(callId)) return ids.slice();
  const next = [...ids, callId];
  return next.length > CONCLUDED_ID_LIMIT ? next.slice(next.length - CONCLUDED_ID_LIMIT) : next;
}

/**
 * Whether a signaling event belongs to the call on screen.
 * A pending outgoing id has not been replaced by the server echo yet, so a
 * foreign id is NOT applied immediately (it may be a late event from the
 * previous call). Unscoped events (busy, no call id) apply only to that
 * in-flight outgoing attempt.
 */
/**
 * Only the caller restarts ICE, and only once per drop of a call that was
 * already connected. The callee answers that offer. A second attempt, a
 * still-ringing call, or the incoming side must not start a competing offer.
 */
/**
 * UI mute/camera flags derived from the live tracks, so a reconnect cannot
 * show "unmuted" or "camera on" when the capture track says otherwise.
 * A missing audio track does not invent a mute (the call may still be starting).
 */
export function controlsFromMedia(args: {
  audioEnabled: boolean | null;
  videoLive: boolean;
  isVideoCall: boolean;
}): { muted: boolean | null; cameraOff: boolean } {
  return {
    muted: args.audioEnabled === null ? null : !args.audioEnabled,
    cameraOff: args.isVideoCall && !args.videoLive
  };
}

/**
 * Output-device selection exists only where the browser implements setSinkId.
 * Everywhere else the speaker control mutes playback and must not throw.
 */
export function speakerOutputSupported(
  mediaElement?: { setSinkId?: unknown } | null
): boolean {
  try {
    if (mediaElement && typeof mediaElement.setSinkId === 'function') return true;
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  } catch {
    return false;
  }
}

export function shouldInitiateIceRestart(args: {
  direction: CallDirection | null;
  callState: CallState | null;
  alreadyAttempted: boolean;
}): boolean {
  return args.direction === 'OUTGOING' && args.callState === 'CONNECTED' && !args.alreadyAttempted;
}

export function signalAppliesToActiveCall(args: {
  activeCallId: string | null;
  direction: CallDirection | null;
  eventCallId: string | null | undefined;
  recentlyConcludedIds: readonly string[];
  allowUnscoped?: boolean;
}): boolean {
  if (!args.activeCallId || !args.direction) return false;
  const eventId = typeof args.eventCallId === 'string' ? args.eventCallId : '';
  if (!eventId) {
    return (
      !!args.allowUnscoped &&
      args.direction === 'OUTGOING' &&
      args.activeCallId.startsWith('pending-')
    );
  }
  if (args.recentlyConcludedIds.includes(eventId)) return false;
  return args.activeCallId === eventId;
}

/**
 * Local ICE gathered during createOffer often fires before CALL_OFFER has
 * been registered, while the screen still shows `pending-*`. Sending those
 * candidates is a no-op on the server (unknown id, no pair yet) and they are
 * never repeated. Hold them until the outgoing echo supplies the real id.
 */
export function localIceSignalCallId(
  callId: string | null,
  authoritativeId: string | null
): string | null {
  if (authoritativeId) return authoritativeId;
  if (callId && !callId.startsWith('pending-')) return callId;
  return null;
}

/**
 * An answer or remote ICE candidate for the echoed id still belongs to the
 * outgoing attempt while React has not yet replaced `pending-*`. A different
 * id, or one already concluded, must not attach to this attempt.
 */
export function pendingOutgoingEventApplies(args: {
  activeCallId: string | null;
  direction: CallDirection | null;
  eventCallId: string | null | undefined;
  authoritativeId: string | null;
  recentlyConcludedIds: readonly string[];
}): boolean {
  if (
    signalAppliesToActiveCall({
      activeCallId: args.activeCallId,
      direction: args.direction,
      eventCallId: args.eventCallId,
      recentlyConcludedIds: args.recentlyConcludedIds
    })
  ) {
    return true;
  }
  if (args.direction !== 'OUTGOING' || !args.activeCallId?.startsWith('pending-')) return false;
  const eventId = typeof args.eventCallId === 'string' ? args.eventCallId : '';
  if (!eventId || !args.authoritativeId || args.authoritativeId !== eventId) return false;
  if (args.recentlyConcludedIds.includes(eventId)) return false;
  return true;
}

export interface CallStatusInput {
  direction: CallDirection;
  callState: CallState;
  type: CallKind;
  /** Seconds since the call became CONNECTED (0 while not connected). */
  elapsedSec: number;
  /** Outgoing: the offer has not been acknowledged by the server yet. */
  callingOnly?: boolean;
  issue?: CallIssueKind | null;
  reconnecting?: boolean;
}

/**
 * The one-line status shown under the peer's name. The connected wording
 * "Voice call · m:ss" / "Video call · m:ss" is a tested UI contract — keep
 * the "call · " shape stable.
 */
export function describeCallStatus(i: CallStatusInput): string {
  if (i.issue === 'PERMISSION_DENIED') {
    return i.type === 'VIDEO'
      ? 'Camera and microphone permission needed'
      : 'Microphone permission needed';
  }
  if (i.issue === 'MEDIA_ERROR') {
    return i.type === 'VIDEO' ? 'Camera or microphone unavailable' : 'Microphone unavailable';
  }
  if (i.callState === 'CONNECTED') {
    if (i.reconnecting) return 'Reconnecting…';
    return `${i.type === 'VIDEO' ? 'Video' : 'Voice'} call · ${formatDuration(i.elapsedSec)}`;
  }
  if (i.callState === 'CONNECTING') return 'Connecting…';
  return i.direction === 'INCOMING'
    ? `Incoming ${i.type.toLowerCase()} call…`
    : i.callingOnly
      ? 'Calling…'
      : 'Ringing…';
}

/**
 * User-facing copy for permission/media failures. Never includes raw browser
 * error names or messages.
 */
export function mediaIssueMessage(
  issue: CallIssueKind,
  type: CallKind,
  direction: CallDirection
): string {
  const verb = direction === 'INCOMING' ? 'answer' : 'place';
  if (issue === 'PERMISSION_DENIED') {
    return type === 'VIDEO'
      ? `Camera and microphone access is required to ${verb} a video call. Allow them in your browser settings and try again.`
      : `Microphone access is required to ${verb} a call. Allow the microphone in your browser settings and try again.`;
  }
  return type === 'VIDEO'
    ? 'Could not access the camera or microphone. Check that they are connected and not in use by another app.'
    : 'Could not access the microphone. Check that a microphone is connected and not in use by another app.';
}

/** Elapsed seconds since the call became connected (0 when never started). */
export function connectedElapsedSeconds(startedAtMs: number, nowMs: number): number {
  if (!startedAtMs || nowMs < startedAtMs) return 0;
  return Math.floor((nowMs - startedAtMs) / 1000);
}

/** Camera device ids usable for switching (video inputs with a real id). */
export function switchableCameraDeviceIds(
  devices: { kind: string; deviceId?: string }[]
): string[] {
  return devices
    .filter((d) => d.kind === 'videoinput' && !!d.deviceId)
    .map((d) => d.deviceId as string);
}

/**
 * Next camera in a rotation (front ↔ back). Returns null when switching is
 * not supported (fewer than two cameras).
 */
export function pickNextCameraDeviceId(
  currentId: string | null,
  deviceIds: string[]
): string | null {
  if (deviceIds.length < 2) return null;
  const idx = currentId ? deviceIds.indexOf(currentId) : -1;
  return deviceIds[(idx + 1) % deviceIds.length];
}

export type NetworkQuality = 'good' | 'fair' | 'poor' | 'unknown';

function statString(row: object, key: string): string | undefined {
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function statNumber(row: object, key: string): number | undefined {
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function statFlag(row: object, key: string): boolean {
  return (row as Record<string, unknown>)[key] === true;
}

/** Pull loss and RTT out of a getStats() snapshot. Ignores unknown report shapes. */
export function summarizeCallStats(stats: readonly object[]): {
  packetsLost: number | null;
  packetsReceived: number | null;
  roundTripTimeMs: number | null;
} {
  let packetsLost = 0;
  let packetsReceived = 0;
  let sawInbound = false;
  let roundTripTimeMs: number | null = null;
  for (const row of stats) {
    const received = statNumber(row, 'packetsReceived');
    if (statString(row, 'type') === 'inbound-rtp' && received !== undefined) {
      sawInbound = true;
      packetsReceived += received;
      const lost = statNumber(row, 'packetsLost');
      if (lost !== undefined && lost >= 0) packetsLost += lost;
    }
    const selectedPair =
      statString(row, 'type') === 'candidate-pair' &&
      (statFlag(row, 'nominated') || statFlag(row, 'selected') || statString(row, 'state') === 'succeeded');
    if (selectedPair) {
      const seconds = statNumber(row, 'currentRoundTripTime') ?? statNumber(row, 'roundTripTime');
      if (seconds !== undefined && seconds >= 0) roundTripTimeMs = Math.round(seconds * 1000);
    }
  }
  return {
    packetsLost: sawInbound ? packetsLost : null,
    packetsReceived: sawInbound ? packetsReceived : null,
    roundTripTimeMs
  };
}

/**
 * Connection quality from loss and RTT. Needs a small sample before judging
 * loss, so a brand-new call stays `unknown` rather than flashing "poor".
 * Reconnecting is always poor — the link is already down.
 */
export function deriveNetworkQuality(input: {
  reconnecting?: boolean;
  packetsLost?: number | null;
  packetsReceived?: number | null;
  roundTripTimeMs?: number | null;
}): NetworkQuality {
  if (input.reconnecting) return 'poor';
  const received = input.packetsReceived ?? 0;
  const lost = input.packetsLost ?? 0;
  const loss = received + lost >= 20 ? lost / (received + lost) : null;
  const rtt = input.roundTripTimeMs ?? null;
  if (loss == null && rtt == null) return 'unknown';
  if ((loss != null && loss >= 0.08) || (rtt != null && rtt >= 400)) return 'poor';
  if ((loss != null && loss >= 0.03) || (rtt != null && rtt >= 200)) return 'fair';
  return 'good';
}

export function networkQualityLabel(quality: NetworkQuality): string {
  switch (quality) {
    case 'good':
      return 'Good connection';
    case 'fair':
      return 'Unstable connection';
    case 'poor':
      return 'Poor connection';
    default:
      return '';
  }
}

/** Keep a dragged local preview inside the viewport, above the control row. */
export function clampPreviewPosition(
  pos: { x: number; y: number },
  bounds: { width: number; height: number },
  size: { width: number; height: number },
  margin = 12
): { x: number; y: number } {
  const maxX = Math.max(margin, bounds.width - size.width - margin);
  const maxY = Math.max(margin, bounds.height - size.height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, pos.x)),
    y: Math.min(maxY, Math.max(margin, pos.y))
  };
}

/** Camera device ids available right now ([] when unsupported/unavailable). */
export async function listCameraDeviceIds(): Promise<string[]> {
  try {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return [];
    return switchableCameraDeviceIds(await media.enumerateDevices());
  } catch {
    return [];
  }
}
