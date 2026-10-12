/**
 * Pure billing transitions. Webhook delivery, duplicates, and out-of-order
 * events are decided here so tests do not need a payment provider.
 */
import { isPlanCode, PLANS, type PlanCode } from './plans';

export type BillingEventType =
  | 'checkout.completed'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'subscription.canceled'
  | 'subscription.expired';

export type SubStatus = 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED';

export interface SubState {
  plan: PlanCode;
  status: SubStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: PlanCode | null;
  lastEventAt: string | null;
}

export interface BillingEventInput {
  id: string;
  type: BillingEventType;
  createdAt: string;
  plan?: PlanCode;
  periodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

/** Checkout and portal actions may only touch the signed-in user's records. */
export function billingRecordOwnedBy(ownerId: string | null | undefined, actorId: string): boolean {
  return Boolean(ownerId) && ownerId === actorId;
}

/** Clients must never send a subscription or entitlement status. */
export function clientTriedToSetBillingStatus(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  return ['status', 'entitled', 'subscriptionStatus', 'planStatus', 'provider'].some((key) => key in record);
}

export function emptySubscription(): SubState {
  return {
    plan: 'FREE',
    status: 'INCOMPLETE',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledPlan: null,
    lastEventAt: null
  };
}

function isOlder(eventAt: string, lastAt: string | null): boolean {
  if (!lastAt) return false;
  const eventMs = Date.parse(eventAt);
  const lastMs = Date.parse(lastAt);
  if (!Number.isFinite(eventMs) || !Number.isFinite(lastMs)) return false;
  return eventMs < lastMs;
}

export function applyBillingEvent(
  current: SubState | null,
  event: BillingEventInput,
  seenIds: ReadonlySet<string>
): { state: SubState; duplicate: boolean; ignored: boolean } {
  const state = current ? { ...current } : emptySubscription();
  if (!event.id || seenIds.has(event.id)) {
    return { state, duplicate: true, ignored: false };
  }
  if (isOlder(event.createdAt, state.lastEventAt)) {
    return { state, duplicate: false, ignored: true };
  }

  const next: SubState = { ...state, lastEventAt: event.createdAt };
  if (event.type === 'checkout.completed' || event.type === 'invoice.paid') {
    const incoming = event.plan && isPlanCode(event.plan) ? event.plan : next.plan;
    const plan =
      event.type === 'invoice.paid' && next.scheduledPlan && PLANS[next.scheduledPlan]
        ? next.scheduledPlan
        : incoming;
    next.plan = plan === 'FREE' ? next.plan : plan;
    next.status = 'ACTIVE';
    next.cancelAtPeriodEnd = false;
    next.scheduledPlan = null;
    next.currentPeriodEnd = event.periodEnd ?? next.currentPeriodEnd;
  } else if (event.type === 'invoice.payment_failed') {
    next.status = 'PAST_DUE';
  } else if (event.type === 'subscription.canceled') {
    next.status = 'CANCELED';
    next.cancelAtPeriodEnd = event.cancelAtPeriodEnd !== false;
    if (event.periodEnd) next.currentPeriodEnd = event.periodEnd;
    if (!next.currentPeriodEnd || Date.parse(next.currentPeriodEnd) <= Date.parse(event.createdAt)) {
      next.status = 'EXPIRED';
      next.cancelAtPeriodEnd = false;
    }
  } else if (event.type === 'subscription.expired') {
    next.status = 'EXPIRED';
    next.cancelAtPeriodEnd = false;
    next.scheduledPlan = null;
  }
  return { state: next, duplicate: false, ignored: false };
}

/** Downgrade takes effect at the next paid renewal. Upgrade is a new checkout. */
export function schedulePlanChange(state: SubState, target: PlanCode, now = Date.now()): { ok: true; state: SubState } | { ok: false; reason: string } {
  if (state.status !== 'ACTIVE' && state.status !== 'CANCELED') {
    return { ok: false, reason: 'No active subscription to change.' };
  }
  if (PLANS[target].rank >= PLANS[state.plan].rank) {
    return { ok: false, reason: 'Use checkout to upgrade.' };
  }
  if (target === 'FREE') {
    return {
      ok: true,
      state: { ...state, cancelAtPeriodEnd: true, status: 'CANCELED', scheduledPlan: null, lastEventAt: new Date(now).toISOString() }
    };
  }
  return { ok: true, state: { ...state, scheduledPlan: target } };
}
