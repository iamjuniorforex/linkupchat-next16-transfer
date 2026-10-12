/**
 * Phase 16 — profile, discovery, and phone-search rules.
 * Pure helpers so the API and tests share one decision.
 */

export const USERNAME_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export const PROFILE_ACCENTS = ['#6D5EF5', '#22B8FF', '#22C77D', '#FF6B5E', '#F5A623', '#1B1F33'] as const;

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'help',
  'linkup',
  'linkupchat',
  'mod',
  'moderator',
  'official',
  'root',
  'security',
  'support',
  'system'
]);

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username.trim().toLowerCase());
}

export function isValidUsernameShape(username: string): boolean {
  return USERNAME_RE.test(username.trim().toLowerCase());
}

/** First rename is free. Later renames wait out the cooldown. Same name is not a rename. */
export function usernameChangeAllowed(
  current: string,
  next: string,
  changedAt: Date | string | null | undefined,
  now = new Date()
): { ok: true } | { ok: false; message: string } {
  const from = current.trim().toLowerCase();
  const to = next.trim().toLowerCase();
  if (from === to) return { ok: true };
  if (!isValidUsernameShape(to)) {
    return { ok: false, message: 'Use 3–24 lowercase letters, numbers or underscores.' };
  }
  if (isReservedUsername(to)) {
    return { ok: false, message: 'That username is reserved.' };
  }
  if (!changedAt) return { ok: true };
  const at = new Date(changedAt).getTime();
  if (now.getTime() - at < USERNAME_COOLDOWN_MS) {
    return { ok: false, message: 'You can change your username again in 14 days.' };
  }
  return { ok: true };
}

export function isProfileAccent(value: string | null | undefined): boolean {
  return typeof value === 'string' && PROFILE_ACCENTS.includes(value as (typeof PROFILE_ACCENTS)[number]);
}

/** Digits only. Empty when the value has no digits. */
export function phoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * A phone lookup is an exact full number, never a fragment.
 * Letters mean this query is a name search, not a phone search.
 */
export function phoneSearchDigits(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed || /[a-z]/i.test(trimmed)) return null;
  const digits = phoneDigits(trimmed);
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function phonesMatch(stored: string | null | undefined, queryDigits: string): boolean {
  const storedDigits = phoneDigits(stored);
  return storedDigits.length > 0 && storedDigits === queryDigits;
}
