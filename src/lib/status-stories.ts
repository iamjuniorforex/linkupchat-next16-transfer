/**
 * Phase 15 — pure status/story rules.
 *
 * Audience, expiry, archive, reactions, and reply attribution live here so
 * the API and the UI share one decision and tests do not need a database.
 */

export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

export const STATUS_FONTS = [
  { id: 'classic', label: 'Classic' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
  { id: 'condensed', label: 'Condensed' }
] as const;

export const STATUS_FONT_IDS = STATUS_FONTS.map((f) => f.id);

export const STATUS_TEXT_COLORS = ['#FFFFFF', '#1B1F33', '#FFE08A', '#B8F2D0', '#FFD0C8', '#C9D4FF'] as const;

export const STATUS_EMOJIS = ['❤️', '😂', '😮', '😢', '🙏', '🔥'] as const;

export type StatusAudienceMode = 'CONTACTS' | 'CONTACTS_EXCEPT' | 'ONLY_SHARE';
export type StatusFontId = (typeof STATUS_FONTS)[number]['id'];

export function isStatusFont(value: string | null | undefined): value is StatusFontId {
  return STATUS_FONT_IDS.includes(value as StatusFontId);
}

export function isStatusEmoji(value: string | null | undefined): boolean {
  return STATUS_EMOJIS.includes(value as (typeof STATUS_EMOJIS)[number]);
}

export function isStatusTextColor(value: string | null | undefined): boolean {
  return typeof value === 'string' && STATUS_TEXT_COLORS.includes(value as (typeof STATUS_TEXT_COLORS)[number]);
}

/**
 * Per-status audience, after account privacy and blocks have already allowed
 * the viewer. The author always passes. CONTACTS adds no extra restriction.
 * CONTACTS_EXCEPT hides listed people. ONLY_SHARE shows only listed people.
 */
export function audienceAllows(args: {
  viewerId: string;
  authorId: string;
  audience: StatusAudienceMode | null | undefined;
  memberIds: readonly string[];
}): boolean {
  if (args.viewerId === args.authorId) return true;
  const audience = args.audience ?? 'CONTACTS';
  if (audience === 'CONTACTS') return true;
  const listed = args.memberIds.includes(args.viewerId);
  if (audience === 'CONTACTS_EXCEPT') return !listed;
  return listed;
}

export function validateAudienceSelection(args: {
  audience: StatusAudienceMode;
  memberIds: readonly string[];
  authorId: string;
  contactIds: readonly string[];
}): { ok: true; memberIds: string[] } | { ok: false; message: string } {
  const unique = [...new Set(args.memberIds.map((id) => id.trim()).filter(Boolean))].filter(
    (id) => id !== args.authorId
  );
  if (args.audience === 'CONTACTS') {
    return { ok: true, memberIds: [] };
  }
  if (unique.length === 0) {
    return {
      ok: false,
      message: args.audience === 'ONLY_SHARE' ? 'Choose at least one person to share with.' : 'Choose who to exclude.'
    };
  }
  if (unique.length > 50) return { ok: false, message: 'You can list at most 50 people.' };
  const contacts = new Set(args.contactIds);
  if (unique.some((id) => !contacts.has(id))) {
    return { ok: false, message: 'Audience can only include your contacts.' };
  }
  return { ok: true, memberIds: unique };
}

export function isActiveStatus(
  row: { deletedAt?: Date | string | null; archivedAt?: Date | string | null; expiresAt: Date | string },
  now = new Date()
): boolean {
  if (row.deletedAt) return false;
  if (row.archivedAt) return false;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

/** Author archive: expired or explicitly archived, never deleted. */
export function isArchivedStatus(
  row: { deletedAt?: Date | string | null; archivedAt?: Date | string | null; expiresAt: Date | string },
  now = new Date()
): boolean {
  if (row.deletedAt) return false;
  if (row.archivedAt) return true;
  return new Date(row.expiresAt).getTime() <= now.getTime();
}

export function statusFontClass(fontStyle: string | null | undefined): string {
  switch (fontStyle) {
    case 'serif':
      return 'font-serif';
    case 'mono':
      return 'font-mono tracking-tight';
    case 'condensed':
      return 'font-sans font-black uppercase tracking-wide';
    default:
      return 'font-sans';
  }
}

/** Text delivered in the existing direct chat, with attribution to the status. */
export function statusReplyContent(args: {
  reply: string;
  statusType: 'TEXT' | 'IMAGE' | 'VIDEO' | string;
  statusText?: string | null;
}): string {
  const reply = args.reply.trim();
  const kind = args.statusType === 'VIDEO' ? 'video' : args.statusType === 'IMAGE' ? 'photo' : 'text';
  const snippet = (args.statusText ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const about = snippet ? `${kind} status “${snippet}”` : `${kind} status`;
  return `↩️ Reply to ${about}\n${reply}`;
}

export function buildStatusReactionNotice(args: {
  reactorName: string;
  emoji: string;
  notifPreview: boolean;
  statusText?: string | null;
}): { title: string; body: string } {
  const title = `${args.reactorName} reacted ${args.emoji}`;
  if (!args.notifPreview) return { title, body: 'to your status' };
  const snippet = (args.statusText ?? '').trim().slice(0, 80);
  return { title, body: snippet ? `to your status: ${snippet}` : 'to your status' };
}

export function buildStatusReplyNotice(args: {
  senderName: string;
  notifPreview: boolean;
  replyText: string;
}): { title: string; body: string } {
  const title = `${args.senderName} replied to your status`;
  if (!args.notifPreview) return { title, body: 'New status reply' };
  const snippet = args.replyText.trim().slice(0, 120);
  return { title, body: snippet || 'New status reply' };
}

export function buildStatusUpdateNotice(args: {
  authorName: string;
  count: number;
}): { title: string; body: string } {
  const count = Math.max(1, args.count);
  return {
    title: args.authorName,
    body: count === 1 ? 'posted a new status' : `posted ${count} new statuses`
  };
}

/** One reaction per viewer. Same emoji again clears it; a different emoji replaces it. */
export function nextReaction(current: string | null, incoming: string): string | null {
  if (!isStatusEmoji(incoming)) return current;
  if (current === incoming) return null;
  return incoming;
}

export function splitStatusGroups<T extends { statuses: { viewedByMe?: boolean }[] }>(groups: T[]): {
  recent: T[];
  viewed: T[];
} {
  const recent: T[] = [];
  const viewed: T[] = [];
  for (const group of groups) {
    if (group.statuses.some((s) => !s.viewedByMe)) recent.push(group);
    else viewed.push(group);
  }
  return { recent, viewed };
}

export function storyDurationMs(type: string, videoDurationMs?: number | null): number {
  if (type === 'VIDEO') {
    const d = videoDurationMs && videoDurationMs > 0 ? videoDurationMs : 8000;
    return Math.min(30000, Math.max(4000, d));
  }
  return 5000;
}
