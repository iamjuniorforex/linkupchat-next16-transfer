/**
 * LINKUPCHAT realtime event contract (shared by the Socket.IO server and clients).
 * Keeping this module dependency-free allows it to be imported from both
 * the Node realtime server and browser code.
 */

export const EVENTS = {
  // connection
  CONNECTED: 'connected',
  PRESENCE_UPDATE: 'presence:update',

  // typing
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',

  // messages
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  MESSAGE_REACTION: 'message:reaction',
  MESSAGE_READ: 'message:read',
  MESSAGE_DELIVERED: 'message:delivered',

  // conversations
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_READ: 'conversation:read',
  // ephemeral view state: a user is actively looking at a conversation
  CONVERSATION_VIEWING: 'conversation:viewing',
  CONVERSATION_IDLE: 'conversation:idle',

  // notifications
  NOTIFICATION_NEW: 'notification:new',
  // Cross-device read sync. Payload: { ids: string[] | 'all', readAt: string }.
  NOTIFICATION_READ: 'notification:read',

  // status
  STATUS_NEW: 'status:new',
  STATUS_VIEWED: 'status:viewed',
  // a status was deleted by its author before the 24h expiry; open clients
  // drop it from rails/feeds without a refresh (mirrors MESSAGE_DELETED).
  STATUS_DELETED: 'status:deleted',
  STATUS_REACTED: 'status:reacted',
  STATUS_REPLIED: 'status:replied',

  // calls (WebRTC signaling)
  CALL_OFFER: 'call:offer',
  CALL_ANSWER: 'call:answer',
  CALL_ICE: 'call:ice',
  CALL_REJECT: 'call:reject',
  CALL_END: 'call:end',
  CALL_ACCEPT: 'call:accept',
  // Phase 4A: a call attempt was rejected because one side is already in a
  // call (busy). No Call row is created for busy attempts.
  CALL_BUSY: 'call:busy',
  // Phase 4C: camera on/off state for a video call (signaling only — media
  // flows over WebRTC). Browsers do not reliably surface remote track mute,
  // so the camera state is signaled explicitly.
  CALL_CAMERA: 'call:camera',
  // ICE restart for an already-connected call. Forwarded only between the
  // participants of that call — it must never begin a new call.
  CALL_RENEGOTIATE: 'call:renegotiate',

  // Group calls. These must not reuse CALL_OFFER — that event creates a 1:1
  // call. Mesh signaling is participant-to-participant and authorized per hop.
  GROUP_CALL_START: 'group-call:start',
  GROUP_CALL_STARTED: 'group-call:started',
  GROUP_CALL_INVITE: 'group-call:invite',
  GROUP_CALL_ACCEPT: 'group-call:accept',
  GROUP_CALL_DECLINE: 'group-call:decline',
  GROUP_CALL_JOINED: 'group-call:joined',
  GROUP_CALL_PEER: 'group-call:peer',
  GROUP_CALL_LEAVE: 'group-call:leave',
  GROUP_CALL_END: 'group-call:end',
  GROUP_CALL_ENDED: 'group-call:ended',
  GROUP_CALL_SIGNAL: 'group-call:signal',
  GROUP_CALL_STATE: 'group-call:state',
  GROUP_CALL_REJOIN: 'group-call:rejoin',
  GROUP_CALL_ERROR: 'group-call:error',
  GROUP_CALL_BUSY: 'group-call:busy',

  // presence of typing state for groups is aggregated server-side
  ERROR: 'error'
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface CallSignalPayload {
  callId: string;
  from: string;
  to: string;
  type: 'VOICE' | 'VIDEO';
  sdp?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit | null;
}

/** Wire reason on CALL_END (Phase 4A). */
export type CallEndReason = 'ENDED' | 'CANCELLED' | 'TIMEOUT' | 'DISCONNECTED';

export interface CallEndPayload {
  callId: string;
  from: string;
  durationSec: number;
  reason?: CallEndReason;
}

export interface CallBusyPayload {
  callId: string | null;
  from: string;
  to: string;
  reason: 'CALLER_BUSY' | 'CALLEE_BUSY';
}

export interface CallCameraPayload {
  callId: string;
  from: string;
  to: string;
  videoEnabled: boolean;
}

export interface TypingPayload {
  conversationId: string;
  userId: string;
  username: string;
  displayName: string;
}

export interface PresencePayload {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

export interface MessageReadPayload {
  conversationId: string;
  userId: string;
  messageId: string;
  readAt: string;
}

export interface MessageDeliveredPayload {
  conversationId: string;
  userId: string;
  messageId?: string | null;
  deliveredAt: string;
}

export const ROOM = {
  user: (userId: string) => `user:${userId}`,
  conversation: (conversationId: string) => `conv:${conversationId}`
} as const;
