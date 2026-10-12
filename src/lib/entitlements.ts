/**
 * Central entitlement rules. Protected routes must call these — never trust
 * a client-sent plan or status.
 */
import {
  FREE_UPLOAD_BYTES,
  PLANS,
  PREMIUM_UPLOAD_BYTES,
  type Entitlement,
  type PlanCode
} from './plans';

export type SubscriptionStatus = 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED';

export interface SubscriptionSnapshot {
  plan: PlanCode;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | string | null;
  cancelAtPeriodEnd?: boolean;
}

export function periodEndMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Active access, or a cancellation that has not reached the paid period end. */
export function subscriptionGrantsAccess(sub: SubscriptionSnapshot | null | undefined, now = Date.now()): boolean {
  if (!sub || sub.plan === 'FREE') return false;
  if (sub.status === 'ACTIVE') return true;
  if (sub.status === 'CANCELED') {
    const end = periodEndMs(sub.currentPeriodEnd);
    return end != null && end > now;
  }
  return false;
}

export function effectivePlan(sub: SubscriptionSnapshot | null | undefined, now = Date.now()): PlanCode {
  if (!subscriptionGrantsAccess(sub, now)) return 'FREE';
  return sub!.plan;
}

export function entitlementsFor(plan: PlanCode): Entitlement[] {
  return [...PLANS[plan].entitlements];
}

export function hasEntitlement(plan: PlanCode, entitlement: Entitlement): boolean {
  return PLANS[plan].entitlements.includes(entitlement);
}

export function uploadLimitBytes(plan: PlanCode, purpose: string): number {
  if (purpose === 'avatar' || purpose === 'cover' || purpose === 'group') return 5 * 1024 * 1024;
  if (hasEntitlement(plan, 'premium.upload')) return PREMIUM_UPLOAD_BYTES;
  return FREE_UPLOAD_BYTES;
}

export function comparePlans(a: PlanCode, b: PlanCode): number {
  return PLANS[a].rank - PLANS[b].rank;
}

/** Premium badge, or the distinct Business badge. Never both. */
export function badgeFor(plan: PlanCode): 'premium' | 'business' | null {
  if (hasEntitlement(plan, 'business.profile')) return 'business';
  if (hasEntitlement(plan, 'premium.badge')) return 'premium';
  return null;
}
