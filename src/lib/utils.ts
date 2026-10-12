import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function isToday(d: Date) {
  const now = new Date();
  return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

export function isYesterday(d: Date) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return d.getDate() === y.getDate() && d.getMonth() === y.getMonth() && d.getFullYear() === y.getFullYear();
}

/** Chat list timestamp: time for today, day name this week, else date. */
export function formatChatListTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isToday(d)) return formatTime(d);
  if (isYesterday(d)) return 'Yesterday';
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatDateSeparator(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function formatRelativeLastSeen(date: Date | string | null): string {
  if (!date) return 'a while ago';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (isToday(d)) return `today at ${formatTime(d)}`;
  if (isYesterday(d)) return `yesterday at ${formatTime(d)}`;
  return `${formatDate(d)} at ${formatTime(d)}`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** Deterministic avatar gradient from a user id/name — no external images needed. */
export function avatarGradient(seed: string): string {
  const palettes = [
    ['#6D5EF5', '#22B8FF'],
    ['#FF6B5E', '#F5A623'],
    ['#22C77D', '#22B8FF'],
    ['#8481FB', '#FF8A7A'],
    ['#22B8FF', '#3DDC97'],
    ['#F5A623', '#FF6B5E'],
    ['#4B38BF', '#3DDC97'],
    ['#FF8A7A', '#8481FB']
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 9973;
  const [a, b] = palettes[hash % palettes.length]!;
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

export function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function linkify(text: string): { text: string; href?: string }[] {
  const urlRegex = /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g;
  const parts: { text: string; href?: string }[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(urlRegex)) {
    const idx = match.index!;
    if (idx > lastIndex) parts.push({ text: text.slice(lastIndex, idx) });
    parts.push({ text: match[1]!, href: match[1]! });
    lastIndex = idx + match[1]!.length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) });
  return parts;
}

export function generateIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const EMOJI_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'] as const;

/** Server-validated whitelist of supported reaction emojis. */
export const REACTION_EMOJIS: readonly string[] = EMOJI_REACTIONS;

export function isSupportedReaction(emoji: unknown): emoji is string {
  return typeof emoji === 'string' && (REACTION_EMOJIS as readonly string[]).includes(emoji);
}

/**
 * Compact preview text for quoted replies and the composer reply banner.
 * Deleted messages never leak their old content; media types get an
 * appropriate label instead of invalid/unavailable content.
 */
export function formatReplyPreview(m: {
  type: string;
  content?: string | null;
  deletedAt?: string | boolean | null;
} | null | undefined): string {
  if (!m) return 'Message';
  if (m.deletedAt) return 'This message was deleted';
  if (m.type === 'TEXT' && m.content) return m.content;
  if (m.type === 'STICKER' && m.content) return m.content;
  const labels: Record<string, string> = {
    IMAGE: '📷 Photo',
    VIDEO: '🎥 Video',
    VOICE: '🎤 Voice message',
    AUDIO: '🎵 Audio',
    DOCUMENT: '📄 Document',
    GIF: 'GIF',
    STICKER: 'Sticker'
  };
  return labels[m.type] ?? (m.content || 'Attachment');
}

export type ReactionEntry = {
  emoji: string;
  count: number;
  userIds: string[];
  reacted: boolean;
};

/**
 * One reaction per user per message: selecting an emoji REPLACES the user's
 * previous emoji, selecting their current emoji REMOVES it. Pure shared
 * semantics — used by the client's optimistic update and covered by unit
 * tests. `me` may be undefined (view-only); in that case nothing changes.
 */
export function applyReactionToggle(
  reactions: ReactionEntry[],
  meId: string | undefined,
  emoji: string
): ReactionEntry[] {
  if (!meId) return reactions;
  const next: ReactionEntry[] = [];
  let hadSame = false;

  for (const r of reactions) {
    // Strip this user from every emoji group first (they may switch emojis).
    const userIds = r.userIds.filter((id) => id !== meId);
    const wasMine = r.userIds.includes(meId) && r.emoji === emoji;
    if (wasMine) hadSame = true;
    if (userIds.length > 0) {
      next.push({
        emoji: r.emoji,
        count: userIds.length,
        userIds,
        reacted: false
      });
    }
  }

  if (hadSame) {
    // Same emoji selected again → reaction removed.
    return next.map((r) => ({ ...r, reacted: false }));
  }
  // Add (or replace onto) the chosen emoji.
  const existing = next.find((r) => r.emoji === emoji);
  if (existing) {
    existing.count += 1;
    existing.userIds = [...existing.userIds, meId];
    existing.reacted = true;
  } else {
    next.push({ emoji, count: 1, userIds: [meId], reacted: true });
  }
  return next;
}

export const STICKERS = [
  '🎉', '🔥', '💯', '✨', '😎', '🥳', '😴', '🙌', '💪', '🤝',
  '🚀', '🌈', '⭐', '🍕', '☕', '🎮', '⚽', '🎵', '💜', '🦄'
] as const;

export const EMOJI_SET: Record<string, string[]> = {
  Smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫠', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐'],
  Gestures: ['👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '🫵', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '💪', '🫂'],
  Hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟'],
  Nature: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🌸', '💐', '🌷', '🌹', '🌺', '🌻', '🌼', '🌈', '⭐', '🌟', '✨', '⚡', '🔥', '💧', '🌊'],
  Food: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥕', '🌽', '🍞', '🥐', '🥖', '🧀', '🍳', '🥞', '🍕', '🍔', '🍟', '🌭', '🍿', '🍣', '🍜', '🍦', '🍩', '🍪', '🎂', '🍰', '☕', '🍵', '🥤', '🍺', '🍻'],
  Activities: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🥅', '🏒', '🏑', '🥍', '🏏', '🪃', '🥊', '🥋', '🎽', '🛹', '🛼', '🎿', '🏂', '🏋️', '🤸', '⛹️', '🤺', '🤾', '🏌️', '🏇', '🧘', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🎵', '🎶', '🎤', '🎧', '🎮', '🕹️', '🎲', '🎯', '🎨', '🎭'],
  Travel: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🚚', '🚛', '🚜', '🛵', '🏍️', '🚲', '🛴', '✈️', '🚁', '🚂', '🚀', '🛸', '🚢', '⛵', '🗺️', '🗿', '🗽', '🏰', '🏯', '🗼', '🌇', '🌆', '🌃', '🌌', '🎆', '🎇', '🌠', '🌍', '🌎', '🌏', '🌞', '🌝', '🌙', '⭐'],
  Objects: ['⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💿', '📀', '💾', '📷', '📸', '📹', '🎥', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '⏱️', '⏰', '🔋', '💡', '🔦', '📚', '📖', '📝', '✏️', '🖊️', '📌', '📎', '🔒', '🔑', '🎁', '🎉', '🎈', '🎊', '🪄', '💰', '💳', '📦', '📫', '🚀', '💤']
};
