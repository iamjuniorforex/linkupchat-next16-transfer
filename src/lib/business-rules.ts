export type VerificationStatus = 'UNVERIFIED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export function requestVerification(current: VerificationStatus): { ok: true; status: 'PENDING' } | { ok: false; reason: string } {
  if (current === 'PENDING') return { ok: false, reason: 'Verification is already pending review.' };
  if (current === 'APPROVED') return { ok: false, reason: 'This business is already verified.' };
  return { ok: true, status: 'PENDING' };
}

export function reviewVerification(opts: {
  actorId: string;
  actorRole: string;
  targetUserId: string;
  decision: 'APPROVED' | 'REJECTED';
}): { ok: true; status: 'APPROVED' | 'REJECTED' } | { ok: false; reason: string } {
  if (opts.actorRole !== 'ADMIN' && opts.actorRole !== 'MODERATOR') {
    return { ok: false, reason: 'Only moderators can review verification.' };
  }
  if (opts.actorId === opts.targetUserId) {
    return { ok: false, reason: 'You cannot review your own business.' };
  }
  if (opts.decision !== 'APPROVED' && opts.decision !== 'REJECTED') {
    return { ok: false, reason: 'Decision must be approved or rejected.' };
  }
  return { ok: true, status: opts.decision };
}

export const AWAY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function shouldSendAway(opts: {
  awayEnabled: boolean;
  entitled: boolean;
  senderIsBusiness: boolean;
  blocked: boolean;
  lastAwayAt: Date | string | null;
  now?: number;
}): boolean {
  if (!opts.awayEnabled || !opts.entitled || opts.senderIsBusiness || opts.blocked) return false;
  const now = opts.now ?? Date.now();
  if (!opts.lastAwayAt) return true;
  const last = opts.lastAwayAt instanceof Date ? opts.lastAwayAt.getTime() : Date.parse(opts.lastAwayAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= AWAY_COOLDOWN_MS;
}

export function isSafeWebsite(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export const BUSINESS_CATEGORIES = ['RETAIL', 'FOOD', 'SERVICES', 'HEALTH', 'EDUCATION', 'OTHER'] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export function validateBusinessProfile(input: unknown):
  | {
      ok: true;
      value: {
        name: string;
        description: string | null;
        category: BusinessCategory;
        phone: string | null;
        email: string | null;
        website: string | null;
        greeting: string | null;
        awayMessage: string | null;
        awayEnabled: boolean;
      };
    }
  | { ok: false; reason: string } {
  const body = (input ?? {}) as Record<string, unknown>;
  const name = clean(body.name ?? body.displayName, 80);
  if (!name) return { ok: false, reason: 'Business name is required.' };
  const category = BUSINESS_CATEGORIES.includes(body.category as BusinessCategory)
    ? (body.category as BusinessCategory)
    : 'OTHER';
  const website = clean(body.website, 200);
  if (website && !isSafeWebsite(website)) return { ok: false, reason: 'Website must be an http or https link.' };
  const email = clean(body.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: 'Enter a valid business email.' };
  return {
    ok: true,
    value: {
      name,
      description: clean(body.description, 500),
      category,
      phone: clean(body.phone, 40),
      email,
      website,
      greeting: clean(body.greeting, 500),
      awayMessage: clean(body.awayMessage, 500),
      awayEnabled: body.awayEnabled === true
    }
  };
}

export function validateQuickReply(input: unknown):
  | { ok: true; value: { title: string; body: string } }
  | { ok: false; reason: string } {
  const body = (input ?? {}) as Record<string, unknown>;
  const title = clean(body.title, 40);
  const text = clean(body.body, 1000);
  if (!title) return { ok: false, reason: 'Quick reply title is required.' };
  if (!text) return { ok: false, reason: 'Quick reply text is required.' };
  return { ok: true, value: { title, body: text } };
}
