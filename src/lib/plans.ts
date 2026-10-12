/**
 * Phase 19 plan catalog. Prices are integer minor units (cents). No card data.
 */

export const PLAN_CODES = ['FREE', 'PREMIUM_MONTHLY', 'PREMIUM_YEARLY', 'BUSINESS_MONTHLY'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const ENTITLEMENTS = [
  'premium.badge',
  'premium.themes',
  'premium.chatTheme',
  'premium.upload',
  'business.profile',
  'business.tools'
] as const;
export type Entitlement = (typeof ENTITLEMENTS)[number];

export const FREE_UPLOAD_BYTES = 25 * 1024 * 1024;
export const PREMIUM_UPLOAD_BYTES = 100 * 1024 * 1024;
export const AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024;

const PREMIUM: Entitlement[] = ['premium.badge', 'premium.themes', 'premium.chatTheme', 'premium.upload'];
const BUSINESS: Entitlement[] = [...PREMIUM, 'business.profile', 'business.tools'];

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  amountMinor: number;
  currency: 'USD';
  interval: 'month' | 'year' | null;
  entitlements: Entitlement[];
  rank: number;
}

export const PLANS: Record<PlanCode, PlanDefinition> = {
  FREE: { code: 'FREE', name: 'Free', amountMinor: 0, currency: 'USD', interval: null, entitlements: [], rank: 0 },
  PREMIUM_MONTHLY: {
    code: 'PREMIUM_MONTHLY',
    name: 'Premium',
    amountMinor: 499,
    currency: 'USD',
    interval: 'month',
    entitlements: PREMIUM,
    rank: 1
  },
  PREMIUM_YEARLY: {
    code: 'PREMIUM_YEARLY',
    name: 'Premium yearly',
    amountMinor: 3999,
    currency: 'USD',
    interval: 'year',
    entitlements: PREMIUM,
    rank: 2
  },
  BUSINESS_MONTHLY: {
    code: 'BUSINESS_MONTHLY',
    name: 'Business',
    amountMinor: 1999,
    currency: 'USD',
    interval: 'month',
    entitlements: BUSINESS,
    rank: 3
  }
};

export const PAID_PLANS: PlanCode[] = ['PREMIUM_MONTHLY', 'PREMIUM_YEARLY', 'BUSINESS_MONTHLY'];

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && (PLAN_CODES as readonly string[]).includes(value);
}

export function formatMinor(amountMinor: number, currency = 'USD'): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(amountMinor));
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  return `${sign}${currency === 'USD' ? '$' : ''}${major}.${minor}`;
}

export const CHAT_THEMES = ['default', 'midnight', 'sunset', 'forest'] as const;
export type ChatThemeKey = (typeof CHAT_THEMES)[number];

export function isChatTheme(value: unknown): value is ChatThemeKey {
  return typeof value === 'string' && (CHAT_THEMES as readonly string[]).includes(value);
}

export const PREMIUM_WALLPAPERS = ['midnight', 'sunset', 'forest'] as const;

export function isPremiumWallpaper(value: string): boolean {
  return (PREMIUM_WALLPAPERS as readonly string[]).includes(value);
}
