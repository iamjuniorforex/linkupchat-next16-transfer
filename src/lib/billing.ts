/**
 * Subscription writes. Clients never set status. Redirects are not proof of
 * payment — only a verified webhook or the test-mode complete path, which
 * records a simulated event and never claims a live charge.
 */
import { db } from './db';
import {
  applyBillingEvent,
  billingRecordOwnedBy,
  emptySubscription,
  schedulePlanChange,
  type BillingEventInput,
  type SubState
} from './billing-events';
import { verifyStripeSignature, verifyTestWebhook } from './billing-signature';
import { effectivePlan, periodEndMs, subscriptionGrantsAccess, type SubscriptionSnapshot } from './entitlements';
import { isPlanCode, PAID_PLANS, PLANS, type PlanCode } from './plans';

export function billingMode(): 'test' | 'live' | 'unconfigured' {
  if (process.env.BILLING_MODE === 'live') return 'live';
  if (process.env.BILLING_MODE === 'test') return 'test';
  return 'unconfigured';
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

export function priceIdFor(plan: PlanCode): string | null {
  const key =
    plan === 'PREMIUM_MONTHLY'
      ? 'STRIPE_PRICE_PREMIUM_MONTHLY'
      : plan === 'PREMIUM_YEARLY'
        ? 'STRIPE_PRICE_PREMIUM_YEARLY'
        : plan === 'BUSINESS_MONTHLY'
          ? 'STRIPE_PRICE_BUSINESS_MONTHLY'
          : '';
  const value = key ? process.env[key] : '';
  return value && value.trim() ? value.trim() : null;
}

function appUrl(): string {
  return (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function periodEndFor(plan: PlanCode, from = Date.now()): string {
  const days = plan === 'PREMIUM_YEARLY' ? 365 : 30;
  return new Date(from + days * 24 * 60 * 60 * 1000).toISOString();
}

function toState(row: {
  plan: PlanCode;
  status: SubState['status'];
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: PlanCode | null;
  lastEventAt: Date | null;
} | null): SubState | null {
  if (!row) return null;
  return {
    plan: row.plan,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    scheduledPlan: row.scheduledPlan,
    lastEventAt: row.lastEventAt?.toISOString() ?? null
  };
}

export async function loadSubscription(userId: string) {
  const row = await db.subscription.findUnique({ where: { userId } });
  const expired = await expireIfDue(row);
  return expired ?? row;
}

async function expireIfDue<T extends { id: string; status: string; currentPeriodEnd: Date | null; plan: PlanCode }>(row: T | null) {
  if (!row?.currentPeriodEnd) return row;
  if (row.status !== 'ACTIVE' && row.status !== 'CANCELED') return row;
  if (row.currentPeriodEnd.getTime() > Date.now()) return row;
  return db.subscription.update({
    where: { id: row.id },
    data: { status: 'EXPIRED', cancelAtPeriodEnd: false, scheduledPlan: null }
  });
}

export async function accessFor(userId: string) {
  const row = await loadSubscription(userId);
  const snapshot: SubscriptionSnapshot | null = row
    ? { plan: row.plan, status: row.status, currentPeriodEnd: row.currentPeriodEnd, cancelAtPeriodEnd: row.cancelAtPeriodEnd }
    : null;
  const plan = effectivePlan(snapshot);
  return {
    plan,
    status: subscriptionGrantsAccess(snapshot) ? snapshot!.status : row?.status ?? 'INCOMPLETE',
    entitled: subscriptionGrantsAccess(snapshot),
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    scheduledPlan: row?.scheduledPlan ?? null,
    provider: row?.provider ?? 'NONE',
    simulated: row?.provider === 'TEST'
  };
}

export async function publicPlans() {
  const mode = billingMode();
  return {
    mode,
    provider: mode === 'live' && stripeConfigured() ? 'stripe' : mode === 'test' ? 'test' : 'none',
    liveCharges: mode === 'live' && stripeConfigured(),
    simulated: mode === 'test',
    plans: PAID_PLANS.map((code) => ({
      code,
      name: PLANS[code].name,
      amountMinor: PLANS[code].amountMinor,
      currency: PLANS[code].currency,
      interval: PLANS[code].interval,
      entitlements: PLANS[code].entitlements
    }))
  };
}

export async function startCheckout(userId: string, plan: PlanCode) {
  if (!isPlanCode(plan) || plan === 'FREE') {
    throw new Error('Choose a paid plan.');
  }
  const mode = billingMode();
  if (mode === 'unconfigured') throw new Error('Billing is not configured.');
  if (mode === 'live') {
    if (!stripeConfigured()) throw new Error('Billing is not configured.');
    const price = priceIdFor(plan);
    if (!price) throw new Error('This plan is not available for checkout yet.');
    return startStripeCheckout(userId, plan, price);
  }
  const session = await db.checkoutSession.create({
    data: { userId, plan, provider: 'TEST', simulated: true, status: 'PENDING' }
  });
  return {
    mode: 'test' as const,
    simulated: true,
    sessionId: session.id,
    url: `${appUrl()}/app/premium?checkout=${session.id}`
  };
}

async function startStripeCheckout(userId: string, plan: PlanCode, price: string) {
  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    success_url: `${appUrl()}/app/premium?checkout=success`,
    cancel_url: `${appUrl()}/app/premium?checkout=cancel`,
    client_reference_id: userId,
    'metadata[userId]': userId,
    'metadata[plan]': plan
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !json.url || !json.id) {
    throw new Error('Checkout could not be started.');
  }
  await db.checkoutSession.create({
    data: { userId, plan, provider: 'STRIPE', providerSessionId: json.id, simulated: false }
  });
  return { mode: 'live' as const, simulated: false, sessionId: json.id, url: json.url };
}

export async function startPortal(userId: string) {
  const sub = await db.subscription.findUnique({ where: { userId } });
  if (billingMode() !== 'live' || !stripeConfigured() || !sub?.providerCustomerId) {
    return { mode: billingMode(), url: `${appUrl()}/app/premium`, simulated: billingMode() !== 'live' };
  }
  const body = new URLSearchParams({
    customer: sub.providerCustomerId,
    return_url: `${appUrl()}/app/premium`
  });
  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const json = (await res.json().catch(() => ({}))) as { url?: string };
  if (!res.ok || !json.url) throw new Error('Billing portal is unavailable.');
  return { mode: 'live' as const, url: json.url, simulated: false };
}

export async function completeTestCheckout(userId: string, sessionId: string) {
  if (billingMode() !== 'test') {
    throw new Error('Simulated checkout is disabled.');
  }
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId } });
  if (!session || session.provider !== 'TEST' || !billingRecordOwnedBy(session.userId, userId)) {
    throw new Error('Checkout session not found.');
  }
  if (session.status === 'COMPLETED') {
    return { simulated: true, duplicate: true, plan: session.plan };
  }
  const event: BillingEventInput = {
    id: `test:${session.id}`,
    type: 'checkout.completed',
    createdAt: new Date().toISOString(),
    plan: session.plan,
    periodEnd: periodEndFor(session.plan)
  };
  await persistEvent(userId, 'TEST', event, true);
  await db.checkoutSession.update({
    where: { id: session.id },
    data: { status: 'COMPLETED', completedAt: new Date(), simulated: true }
  });
  return { simulated: true, duplicate: false, plan: session.plan };
}

export async function cancelSubscription(userId: string) {
  const row = await loadSubscription(userId);
  if (!row || !subscriptionGrantsAccess(row)) throw new Error('No active subscription.');
  const state = toState(row) ?? emptySubscription();
  const changed = schedulePlanChange(state, 'FREE');
  if (!changed.ok) throw new Error(changed.reason);
  await db.subscription.update({
    where: { userId },
    data: {
      status: 'CANCELED',
      cancelAtPeriodEnd: true,
      canceledAt: new Date(),
      scheduledPlan: null
    }
  });
  return { cancelAtPeriodEnd: true, currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null };
}

export async function scheduleDowngrade(userId: string, target: PlanCode) {
  const row = await loadSubscription(userId);
  if (!row) throw new Error('No subscription.');
  const changed = schedulePlanChange(toState(row) ?? emptySubscription(), target);
  if (!changed.ok) throw new Error(changed.reason);
  if (target === 'FREE') return cancelSubscription(userId);
  await db.subscription.update({ where: { userId }, data: { scheduledPlan: target } });
  return { scheduledPlan: target, currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null };
}

export async function listInvoices(userId: string) {
  const rows = await db.invoice.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 24
  });
  return rows.map((row) => ({
    id: row.id,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    description: row.description,
    hostedUrl: row.hostedUrl,
    simulated: row.simulated,
    createdAt: row.createdAt.toISOString()
  }));
}

async function seenIds(provider: 'TEST' | 'STRIPE', eventId: string) {
  const existing = await db.billingEvent.findUnique({ where: { provider_eventId: { provider, eventId } } });
  return existing ? new Set([eventId]) : new Set<string>();
}

async function persistEvent(userId: string, provider: 'TEST' | 'STRIPE', event: BillingEventInput, simulated: boolean) {
  const current = await db.subscription.findUnique({ where: { userId } });
  const seen = await seenIds(provider, event.id);
  const applied = applyBillingEvent(toState(current), event, seen);
  if (applied.duplicate || applied.ignored) return applied;
  const next = applied.state;
  try {
  await db.$transaction(async (tx) => {
    await tx.billingEvent.create({
      data: { provider, eventId: event.id, type: event.type, userId }
    });
    await tx.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan: next.plan,
        status: next.status,
        provider,
        currentPeriodEnd: next.currentPeriodEnd ? new Date(next.currentPeriodEnd) : null,
        currentPeriodStart: new Date(event.createdAt),
        cancelAtPeriodEnd: next.cancelAtPeriodEnd,
        scheduledPlan: next.scheduledPlan,
        lastEventAt: new Date(event.createdAt),
        canceledAt: next.status === 'CANCELED' || next.status === 'EXPIRED' ? new Date(event.createdAt) : null
      },
      update: {
        plan: next.plan,
        status: next.status,
        provider,
        currentPeriodEnd: next.currentPeriodEnd ? new Date(next.currentPeriodEnd) : null,
        cancelAtPeriodEnd: next.cancelAtPeriodEnd,
        scheduledPlan: next.scheduledPlan,
        lastEventAt: new Date(event.createdAt),
        canceledAt: next.status === 'CANCELED' || next.status === 'EXPIRED' ? new Date(event.createdAt) : undefined
      }
    });
    if (event.type === 'checkout.completed' || event.type === 'invoice.paid') {
      await tx.invoice.create({
        data: {
          userId,
          provider,
          providerInvoiceId: event.id,
          amountMinor: PLANS[next.plan].amountMinor,
          currency: 'USD',
          status: 'paid',
          description: `${PLANS[next.plan].name} subscription`,
          simulated
        }
      });
    }
    if (event.type === 'invoice.payment_failed') {
      await tx.invoice.create({
        data: {
          userId,
          provider,
          providerInvoiceId: event.id,
          amountMinor: PLANS[next.plan].amountMinor,
          currency: 'USD',
          status: 'failed',
          description: `${PLANS[next.plan].name} payment failed`,
          simulated
        }
      });
    }
  });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') return { state: toState(current) ?? emptySubscription(), duplicate: true, ignored: false };
    throw err;
  }
  return applied;
}

export async function receiveWebhook(raw: string, headers: Headers) {
  const stripeHeader = headers.get('stripe-signature');
  const testHeader = headers.get('x-linkup-signature');
  if (stripeHeader) {
    if (!process.env.STRIPE_WEBHOOK_SECRET || !verifyStripeSignature(raw, stripeHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
      return { ok: false as const, status: 401, reason: 'invalid-signature' };
    }
    return applyStripeEvent(raw);
  }
  if (billingMode() !== 'test') {
    return { ok: false as const, status: 401, reason: 'invalid-signature' };
  }
  const secret = process.env.BILLING_WEBHOOK_SECRET || '';
  if (!verifyTestWebhook(raw, testHeader, secret)) {
    return { ok: false as const, status: 401, reason: 'invalid-signature' };
  }
  const body = JSON.parse(raw) as { id?: string; type?: BillingEventInput['type']; userId?: string; plan?: string; periodEnd?: string };
  if (!body.id || !body.type || !body.userId) return { ok: false as const, status: 400, reason: 'invalid-event' };
  const event: BillingEventInput = {
    id: body.id,
    type: body.type,
    createdAt: new Date().toISOString(),
    plan: isPlanCode(body.plan) ? body.plan : undefined,
    periodEnd: body.periodEnd
  };
  const applied = await persistEvent(body.userId, 'TEST', event, true);
  return { ok: true as const, duplicate: applied.duplicate, ignored: applied.ignored, simulated: true };
}

function stripePeriodEnd(object: Record<string, unknown>, plan: PlanCode | undefined, createdAt: string): string | null {
  if (typeof object.current_period_end === 'number') return new Date(object.current_period_end * 1000).toISOString();
  const lines = object.lines as { data?: { period?: { end?: number } }[] } | undefined;
  const end = lines?.data?.[0]?.period?.end;
  if (typeof end === 'number') return new Date(end * 1000).toISOString();
  return plan ? periodEndFor(plan, Date.parse(createdAt)) : null;
}

async function resolveStripeUser(object: Record<string, unknown>, eventType: string): Promise<string> {
  const metadata = (object.metadata ?? {}) as { userId?: string };
  if (metadata.userId) return metadata.userId;
  if (typeof object.client_reference_id === 'string') return object.client_reference_id;
  const customer = typeof object.customer === 'string' ? object.customer : null;
  if (customer) {
    const byCustomer = await db.subscription.findFirst({ where: { providerCustomerId: customer }, select: { userId: true } });
    if (byCustomer) return byCustomer.userId;
  }
  const subscriptionId =
    typeof object.subscription === 'string'
      ? object.subscription
      : eventType.startsWith('customer.subscription') && typeof object.id === 'string'
        ? object.id
        : null;
  if (subscriptionId) {
    const bySubscription = await db.subscription.findFirst({
      where: { providerSubscriptionId: subscriptionId },
      select: { userId: true }
    });
    if (bySubscription) return bySubscription.userId;
  }
  return '';
}

async function applyStripeEvent(raw: string) {
  const body = JSON.parse(raw) as {
    id?: string;
    type?: string;
    created?: number;
    data?: { object?: Record<string, unknown> };
  };
  if (!body.id || !body.type) return { ok: false as const, status: 400, reason: 'invalid-event' };
  const object = body.data?.object ?? {};
  const userId = await resolveStripeUser(object, body.type);
  if (!userId) return { ok: true as const, duplicate: false, ignored: true, simulated: false };
  const metadata = (object.metadata ?? {}) as { plan?: string };
  const plan = isPlanCode(metadata.plan) ? metadata.plan : undefined;
  const createdAt = new Date((body.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  let event: BillingEventInput | null = null;
  if (body.type === 'checkout.session.completed' || body.type === 'invoice.paid') {
    event = {
      id: body.id,
      type: body.type === 'invoice.paid' ? 'invoice.paid' : 'checkout.completed',
      createdAt,
      plan,
      periodEnd: stripePeriodEnd(object, plan, createdAt)
    };
  } else if (body.type === 'invoice.payment_failed') {
    event = { id: body.id, type: 'invoice.payment_failed', createdAt, plan };
  } else if (body.type === 'customer.subscription.deleted') {
    event = { id: body.id, type: 'subscription.expired', createdAt };
  } else if (body.type === 'customer.subscription.updated' && object.cancel_at_period_end === true) {
    event = {
      id: body.id,
      type: 'subscription.canceled',
      createdAt,
      periodEnd: stripePeriodEnd(object, undefined, createdAt),
      cancelAtPeriodEnd: true
    };
  }
  if (!event) return { ok: true as const, duplicate: false, ignored: true, simulated: false };
  const applied = await persistEvent(userId, 'STRIPE', event, false);
  const customer = typeof object.customer === 'string' ? object.customer : null;
  const subscriptionId =
    typeof object.subscription === 'string'
      ? object.subscription
      : body.type.startsWith('customer.subscription') && typeof object.id === 'string'
        ? object.id
        : null;
  if (customer || subscriptionId) {
    await db.subscription
      .update({
        where: { userId },
        data: {
          providerCustomerId: customer ?? undefined,
          providerSubscriptionId: subscriptionId ?? undefined
        }
      })
      .catch(() => {});
  }
  return { ok: true as const, duplicate: applied.duplicate, ignored: applied.ignored, simulated: false };
}

export function grantsNow(plan: PlanCode, status: SubState['status'], periodEnd: string | null, now = Date.now()) {
  return subscriptionGrantsAccess({ plan, status, currentPeriodEnd: periodEnd }, now) && periodEndMs(periodEnd) !== 0;
}
