import type { NotificationDTO } from '../types';

/**
 * Pure notification-feed math shared by the notification store, bell panel,
 * and the notifications page — plus the server-side notification body /
 * aggregation rules. Side-effect free → unit-testable.
 */

export const NOTIFICATIONS_LIST_CAP = 200;

/**
 * Aggregation (server-side, no schema change): messages from the same
 * conversation within this window roll up into ONE feed entry ("N new
 * messages") instead of N identical-looking rows. The row's `data` keeps the
 * latest messageId (deep link) and a `count`.
 */
export const NOTIF_AGGREGATE_WINDOW_MS = 5 * 60_000;
/** Cap the roll-up: after N in one entry, further messages start a new entry. */
export const NOTIF_AGGREGATE_MAX = 20;

export type NotificationKind =
  | 'TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'VOICE'
  | 'AUDIO'
  | 'DOCUMENT'
  | 'GIF'
  | 'STICKER'
  | 'OTHER';

export interface NotificationData {
  conversationId?: string;
  messageId?: string;
  /** Aggregated entry size (absent or 1 = single message). */
  count?: number;
  /** REACTION rows: who reacted and with what. */
  reactorId?: string;
  emoji?: string;
  /** CALL rows: which call and with whom. */
  callId?: string;
  peerId?: string;
  callKind?: 'VOICE' | 'VIDEO';
  callOutcome?: 'MISSED';
  /** Group message @mentioned this recipient (bypasses conversation mute). */
  mention?: boolean;
  kind?: string;
}

// ── Feed merge / dedupe ──────────────────────────────────────────────────

/**
 * Merge realtime notifications into the feed without duplicates: same id
 * appears exactly once — a repeated NOTIFICATION_NEW is a no-op, an updated
 * NOTIFICATION_NEW (aggregation roll-up, same id) REPLACES the row — newest
 * first, capped to a sane window.
 */
export function mergeNotifications(
  existing: NotificationDTO[],
  incoming: NotificationDTO[],
  cap: number = NOTIFICATIONS_LIST_CAP
): NotificationDTO[] {
  const byId = new Map<string, NotificationDTO>();
  for (const n of existing) byId.set(n.id, n);
  for (const n of incoming) byId.set(n.id, n); // later copy wins on same id
  return Array.from(byId.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, cap);
}

/** Whether the feed already contains this notification (dedupe check). */
export function hasNotification(list: NotificationDTO[], id: string): boolean {
  return list.some((n) => n.id === id);
}

/**
 * Ingest one realtime NOTIFICATION_NEW payload. Handles both cases:
 *  - new id → append (unreadDelta 1 when unread);
 *  - known id (aggregation update / replay) → replace in place, delta 0.
 */
export function ingestRealtimeNotification(
  list: NotificationDTO[],
  n: NotificationDTO
): { list: NotificationDTO[]; unreadDelta: number } {
  const known = hasNotification(list, n.id);
  return {
    list: mergeNotifications(list, [n]),
    unreadDelta: !known && !n.readAt ? 1 : 0
  };
}

// ── Unread counts / optimistic read ──────────────────────────────────────

export function countUnreadNotifications(list: NotificationDTO[]): number {
  let count = 0;
  for (const n of list) if (!n.readAt) count += 1;
  return count;
}

/** Local optimistic read marking for ids, or 'all'. */
export function applyReadToNotifications(
  list: NotificationDTO[],
  ids: string[] | 'all',
  readAt: string = new Date().toISOString()
): NotificationDTO[] {
  const set = ids === 'all' ? null : new Set(ids);
  return list.map((n) =>
    !n.readAt && (!set || set.has(n.id)) ? { ...n, readAt } : n
  );
}

/** Which notifications in `list` belong to a conversation (deep-link data). */
export function notificationsForConversation(
  list: NotificationDTO[],
  conversationId: string
): NotificationDTO[] {
  return list.filter((n) => n.data?.conversationId === conversationId);
}

// ── Notification data (JSON string column, no schema change) ─────────────

export function parseNotificationData(raw: string | null | undefined): NotificationData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as NotificationData;
  } catch {
    return null;
  }
}

export function buildNotificationData(
  conversationId: string,
  messageId: string | null,
  count: number = 1,
  extra?: { mention?: boolean }
): string {
  const data: NotificationData = { conversationId };
  if (messageId) data.messageId = messageId;
  if (count > 1) data.count = count;
  if (extra?.mention) data.mention = true;
  return JSON.stringify(data);
}

/** data payload for REACTION notifications (deep link + identity). */
export function buildReactionNotificationData(
  conversationId: string,
  messageId: string,
  reactorId: string,
  emoji: string
): string {
  return JSON.stringify({ conversationId, messageId, reactorId, emoji });
}

/**
 * Title/body for a reaction notification ("John reacted ❤️ to your message").
 * notifPreview=false → the body NEVER includes the reacted message's text.
 * Groups get the conversation title appended ("… in Family").
 */
export function buildReactionNotification(opts: {
  reactorName: string;
  emoji: string;
  groupTitle?: string | null;
  notifPreview: boolean;
  messageText?: string | null;
  messageKind?: NotificationKind;
}): { title: string; body: string } {
  const title = `${opts.reactorName} reacted ${opts.emoji}`;
  const suffix = opts.groupTitle ? ` in ${opts.groupTitle}` : '';
  let preview = '';
  if (opts.notifPreview) {
    if (opts.messageKind && opts.messageKind !== 'TEXT' && opts.messageKind !== 'OTHER') {
      preview = `: ${mediaPlaceholder(opts.messageKind)}`;
    } else if (opts.messageText) {
      preview = `: ${opts.messageText.slice(0, 120)}`;
    }
  }
  return { title, body: `to your message${suffix}${preview}` };
}

// ── Missed-call notifications (Phase 4B) ─────────────────────────────────

export interface MissedCallData {
  callId: string;
  conversationId?: string | null;
  peerId: string;
  callKind: 'VOICE' | 'VIDEO';
  callOutcome: 'MISSED';
}

export function buildMissedCallData(opts: {
  callId: string;
  conversationId?: string | null;
  peerId: string;
  callKind: 'VOICE' | 'VIDEO';
}): string {
  const data: MissedCallData = {
    callId: opts.callId,
    conversationId: opts.conversationId ?? undefined,
    peerId: opts.peerId,
    callKind: opts.callKind,
    callOutcome: 'MISSED'
  };
  return JSON.stringify(data);
}

/**
 * Title/body for a missed-call notification ("Missed voice call" / "from Ada").
 * Deliberately minimal: no call content, no message text — call metadata only.
 */
export function buildMissedCallNotification(opts: {
  callerName: string;
  callKind: 'VOICE' | 'VIDEO';
  groupTitle?: string | null;
}): { title: string; body: string } {
  const title = opts.callKind === 'VIDEO' ? 'Missed video call' : 'Missed voice call';
  const body = opts.groupTitle
    ? `from ${opts.callerName} in ${opts.groupTitle}`
    : `from ${opts.callerName}`;
  return { title, body };
}

/**
 * Push/body copy for a call that is still ringing. No SDP, no message text.
 * A missed call uses {@link buildMissedCallNotification} instead — this is
 * not written into the notification center, so an answered call does not
 * leave a stale "incoming" row.
 */
export function buildIncomingCallNotification(opts: {
  callerName: string;
  callKind: 'VOICE' | 'VIDEO';
  groupTitle?: string | null;
}): { title: string; body: string } {
  const title = opts.callKind === 'VIDEO' ? 'Incoming video call' : 'Incoming voice call';
  const body = opts.groupTitle ? `${opts.callerName} in ${opts.groupTitle}` : opts.callerName;
  return { title, body };
}

/**
 * Chats-list activity chip state: the newest UNREAD reaction notification's
 * emoji for a conversation (separate from the message-unread count).
 */export function latestUnreadReactionEmoji(
  list: NotificationDTO[],
  conversationId: string
): string | null {
  // list is newest-first from the feed; fall back to sorting defensively
  const rows = list
    .filter(
      (n) => !n.readAt && n.type === 'REACTION' && n.data?.conversationId === conversationId
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const emoji = rows[0]?.data?.emoji;
  return typeof emoji === 'string' && emoji ? emoji : rows.length > 0 ? '❤️' : null;
}

// ── Notification body (notifPreview privacy) ─────────────────────────────

const MEDIA_PLACEHOLDERS: Record<Exclude<NotificationKind, 'TEXT' | 'OTHER'>, string> = {
  IMAGE: '📷 Photo',
  VIDEO: '🎥 Video',
  VOICE: '🎤 Voice message',
  AUDIO: '🎵 Audio',
  DOCUMENT: '📄 Document',
  GIF: 'GIF',
  STICKER: 'Sticker'
};

export function mediaPlaceholder(kind: NotificationKind): string {
  return kind !== 'TEXT' && kind !== 'OTHER' ? MEDIA_PLACEHOLDERS[kind] : 'New message';
}

/**
 * Build the notification body for a message.
 *
 * notifPreview=false → NEVER contains message text ("New message" only) —
 * enforced here at the point where the body is CREATED (the server stores the
 * generic body; hiding text client-side is not enough).
 * notifPreview=true → text preview (first 120 chars) or media placeholder.
 *
 * count>1 → aggregated entry ("N new messages", optionally with the LATEST
 * preview when previews are enabled).
 */
export function buildNotificationBody(opts: {
  kind: NotificationKind;
  text: string;
  notifPreview: boolean;
  count?: number;
}): string {
  const count = Math.max(1, opts.count ?? 1);
  const preview = opts.notifPreview
    ? opts.kind === 'TEXT'
      ? opts.text.slice(0, 120)
      : mediaPlaceholder(opts.kind)
    : 'New message';

  if (count > 1) {
    return preview && preview !== 'New message' ? `${count} new messages · ${preview}` : `${count} new messages`;
  }
  return preview || 'New message';
}

// ── Aggregation rules (conservative) ─────────────────────────────────────

/**
 * Roll a new message into `existing` only when ALL hold:
 *  - the existing row is still unread (read rows stay read — new entry);
 *  - it is a MESSAGE row for the SAME conversation;
 *  - it was last touched within the burst window;
 *  - its aggregate count is below the cap.
 * `now`/`windowMs`/`max` are parameters for deterministic tests.
 */
export function shouldAggregate(
  existing: {
    type: string;
    readAt: string | Date | null;
    createdAt: string | Date;
    data: string | null;
  } | null,
  opts: {
    conversationId: string;
    now?: number;
    windowMs?: number;
    max?: number;
  }
): boolean {
  if (!existing) return false;
  if (existing.type !== 'MESSAGE') return false;
  if (existing.readAt) return false;
  const data = parseNotificationData(existing.data);
  if (data?.conversationId !== opts.conversationId) return false;
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? NOTIF_AGGREGATE_WINDOW_MS;
  const created = new Date(existing.createdAt).getTime();
  if (!Number.isFinite(created) || now - created > windowMs) return false;
  const max = opts.max ?? NOTIF_AGGREGATE_MAX;
  return (data.count ?? 1) < max;
}

// ── Deep links (internal routes only) ───────────────────────────────────

/**
 * Route-segment safety: ids are cuids (alphanumerics). Anything with path
 * separators, dots, colons, percent-encoding etc. is rejected so notification
 * data can never steer navigation to an external URL or another route.
 */
export function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Deep link target for a notification. Only ever returns internal
 * `/app/chats/...` routes built from validated ids — never trusts URLs in
 * notification data. Message notifications append `?message=<id>` so the chat
 * view can jump to the message WHEN it is part of the loaded window (and fall
 * back to the plain conversation when it is not).
 */
export function notificationDeepLink(n: NotificationDTO): string | null {
  const conv = n.data?.conversationId;
  if (isSafeSegment(conv)) {
    const msg = n.data?.messageId;
    return isSafeSegment(msg) ? `/app/chats/${conv}?message=${msg}` : `/app/chats/${conv}`;
  }
  const kind = n.data?.kind;
  if (kind === 'status-update' || kind === 'status-reaction') return '/app/status';
  if (n.type === 'CALL' || isSafeSegment(n.data?.callId)) return '/app/calls';
  return null;
}

// ── Phase 17: server preference gate, mentions, sound, badge ────────────

export type NotificationChannel = 'MESSAGE' | 'GROUP_MESSAGE' | 'REACTION' | 'CALL' | 'STATUS';

export interface NotificationGateSettings {
  notifEnabled?: boolean | null;
  notifMessages?: boolean | null;
  notifGroups?: boolean | null;
  notifCalls?: boolean | null;
  notifStatus?: boolean | null;
}

/** True when a conversation mute is still in effect. Unparseable values are not muted. */
export function isConversationMuted(
  mutedUntil: Date | string | null | undefined,
  now = Date.now()
): boolean {
  if (!mutedUntil) return false;
  const t = mutedUntil instanceof Date ? mutedUntil.getTime() : Date.parse(mutedUntil);
  return Number.isFinite(t) && t > now;
}

/**
 * Server-side delivery gate. Missing settings default to on (current behavior).
 * Master off blocks every channel. A muted conversation blocks message alerts
 * unless the recipient was @mentioned in a group — mentions do not bypass the
 * group toggle or the master switch.
 */
export function notificationAllowed(opts: {
  channel: NotificationChannel;
  settings?: NotificationGateSettings | null;
  mutedUntil?: Date | string | null;
  mentioned?: boolean;
  now?: number;
}): boolean {
  const s = opts.settings;
  if (s?.notifEnabled === false) return false;
  const muted = isConversationMuted(opts.mutedUntil, opts.now);
  switch (opts.channel) {
    case 'MESSAGE':
    case 'REACTION':
      if (s?.notifMessages === false) return false;
      return !muted;
    case 'GROUP_MESSAGE':
      if (s?.notifGroups === false) return false;
      if (muted && !opts.mentioned) return false;
      return true;
    case 'CALL':
      return s?.notifCalls !== false;
    case 'STATUS':
      return s?.notifStatus !== false;
    default:
      return false;
  }
}

/** @username mention. Usernames are lowercase [a-z0-9_]; the text match is case-insensitive. */
export function isMentioned(text: string | null | undefined, username: string | null | undefined): boolean {
  if (!text || !username) return false;
  const name = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(name)) return false;
  return new RegExp(`(?:^|\\s)@${name}(?![a-z0-9_])`, 'i').test(text);
}

/** Minimum gap so a burst of messages does not stack overlapping tones. */
export const NOTIF_SOUND_GAP_MS = 1200;

/**
 * Foreground message/status sound. Hidden documents stay silent (the OS
 * notification is the background cue). An active call ring wins. Autoplay
 * failure is handled by the player, not by this policy.
 */
export function shouldPlayNotificationSound(opts: {
  soundsEnabled: boolean;
  isNew: boolean;
  documentHidden: boolean;
  callSoundActive: boolean;
  lastPlayedAt: number | null;
  now: number;
}): boolean {
  if (!opts.soundsEnabled || !opts.isNew) return false;
  if (opts.documentHidden || opts.callSoundActive) return false;
  if (opts.lastPlayedAt != null && opts.now - opts.lastPlayedAt < NOTIF_SOUND_GAP_MS) return false;
  return true;
}

/** App-icon badge. 0 clears; the platform cap used here is 99. */
export function badgeCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(99, Math.floor(n));
}
