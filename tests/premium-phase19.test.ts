/**
 * Phase 19 — Premium, Business, and billing rules.
 * No database and no payment provider. HTTP and browser suites are not run here.
 * Run: npm run test:premium:phase19
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import {
  applyBillingEvent,
  billingRecordOwnedBy,
  clientTriedToSetBillingStatus,
  emptySubscription,
  schedulePlanChange
} from '../src/lib/billing-events';
import { signTestWebhook, verifyStripeSignature, verifyTestWebhook } from '../src/lib/billing-signature';
import { badgeFor, effectivePlan, entitlementsFor, subscriptionGrantsAccess, uploadLimitBytes } from '../src/lib/entitlements';
import { FREE_UPLOAD_BYTES, PLANS, PREMIUM_UPLOAD_BYTES, formatMinor, isPlanCode } from '../src/lib/plans';
import { requestVerification, reviewVerification, shouldSendAway, validateBusinessProfile, validateQuickReply } from '../src/lib/business-rules';

const root = process.cwd();
let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.error(err);
  }
}

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

console.log('\n■ Free vs Premium');

check('free has no paid entitlements and premium does', () => {
  assert.deepEqual(entitlementsFor('FREE'), []);
  assert.equal(badgeFor('FREE'), null);
  assert.equal(badgeFor('PREMIUM_MONTHLY'), 'premium');
  assert.equal(badgeFor('BUSINESS_MONTHLY'), 'business');
  assert.ok(entitlementsFor('PREMIUM_YEARLY').includes('premium.themes'));
  assert.ok(entitlementsFor('BUSINESS_MONTHLY').includes('business.tools'));
  assert.equal(entitlementsFor('PREMIUM_MONTHLY').includes('business.tools'), false);
});

check('prices are integer minor units', () => {
  assert.equal(PLANS.FREE.amountMinor, 0);
  assert.equal(PLANS.PREMIUM_MONTHLY.amountMinor, 499);
  assert.equal(PLANS.PREMIUM_YEARLY.amountMinor, 3999);
  assert.equal(PLANS.BUSINESS_MONTHLY.amountMinor, 1999);
  assert.equal(formatMinor(499), '$4.99');
  assert.equal(isPlanCode('FREE'), true);
  assert.equal(isPlanCode('lifetime'), false);
});

check('missing, past-due, expired, and unpaid subscriptions are Free', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(effectivePlan(null, now), 'FREE');
  for (const status of ['INCOMPLETE', 'PAST_DUE', 'EXPIRED'] as const) {
    assert.equal(
      subscriptionGrantsAccess({ plan: 'PREMIUM_MONTHLY', status, currentPeriodEnd: '2026-11-11T00:00:00Z' }, now),
      false
    );
  }
  assert.equal(
    effectivePlan({ plan: 'BUSINESS_MONTHLY', status: 'ACTIVE', currentPeriodEnd: '2026-11-11T00:00:00Z' }, now),
    'BUSINESS_MONTHLY'
  );
});

console.log('\n■ Upload limits');

check('free stays at 25MB and premium messages at 100MB; avatars stay 5MB', () => {
  assert.equal(uploadLimitBytes('FREE', 'message'), FREE_UPLOAD_BYTES);
  assert.equal(uploadLimitBytes('FREE', 'status'), 25 * 1024 * 1024);
  assert.equal(uploadLimitBytes('PREMIUM_MONTHLY', 'message'), PREMIUM_UPLOAD_BYTES);
  assert.equal(uploadLimitBytes('BUSINESS_MONTHLY', 'voice'), 100 * 1024 * 1024);
  assert.equal(uploadLimitBytes('PREMIUM_YEARLY', 'avatar'), 5 * 1024 * 1024);
  assert.equal(uploadLimitBytes('BUSINESS_MONTHLY', 'cover'), 5 * 1024 * 1024);
  assert.equal(uploadLimitBytes('PREMIUM_MONTHLY', 'group'), 5 * 1024 * 1024);
});

check('upload route enforces the server plan, not a client plan', () => {
  const route = read('src/app/api/upload/route.ts');
  assert.match(route, /accessFor\(user\.id\)/);
  assert.match(route, /uploadLimitBytes\(access\.plan, purpose\)/);
  assert.equal(route.includes('form.get(\'plan\')'), false);
  assert.match(route, /maxBytes: limit/);
});

console.log('\n■ Billing transitions');

check('activation, renewal, failure, cancel, and expiration', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const activated = applyBillingEvent(null, {
    id: 'evt_1',
    type: 'checkout.completed',
    createdAt: '2026-10-11T12:00:00Z',
    plan: 'PREMIUM_MONTHLY',
    periodEnd: '2026-11-11T12:00:00Z'
  }, new Set());
  assert.equal(activated.state.status, 'ACTIVE');
  assert.equal(subscriptionGrantsAccess(activated.state, now), true);

  const renewed = applyBillingEvent(activated.state, {
    id: 'evt_2',
    type: 'invoice.paid',
    createdAt: '2026-11-11T12:00:00Z',
    plan: 'PREMIUM_MONTHLY',
    periodEnd: '2026-12-11T12:00:00Z'
  }, new Set(['evt_1']));
  assert.equal(renewed.state.currentPeriodEnd, '2026-12-11T12:00:00Z');
  assert.equal(renewed.state.status, 'ACTIVE');

  const failed = applyBillingEvent(renewed.state, {
    id: 'evt_3',
    type: 'invoice.payment_failed',
    createdAt: '2026-12-11T12:00:00Z'
  }, new Set(['evt_1', 'evt_2']));
  assert.equal(failed.state.status, 'PAST_DUE');
  assert.equal(subscriptionGrantsAccess(failed.state, Date.parse('2026-12-11T12:00:00Z')), false);

  const canceled = applyBillingEvent(activated.state, {
    id: 'evt_c',
    type: 'subscription.canceled',
    createdAt: '2026-10-12T12:00:00Z',
    periodEnd: '2026-11-11T12:00:00Z'
  }, new Set());
  assert.equal(canceled.state.status, 'CANCELED');
  assert.equal(subscriptionGrantsAccess(canceled.state, Date.parse('2026-10-20T00:00:00Z')), true);
  assert.equal(subscriptionGrantsAccess(canceled.state, Date.parse('2026-11-12T00:00:00Z')), false);

  const expired = applyBillingEvent(canceled.state, {
    id: 'evt_e',
    type: 'subscription.expired',
    createdAt: '2026-11-11T12:00:00Z'
  }, new Set());
  assert.equal(expired.state.status, 'EXPIRED');
  assert.equal(effectivePlan(expired.state), 'FREE');
});

check('upgrade requires checkout; downgrade waits for the next invoice', () => {
  const active = {
    ...emptySubscription(),
    plan: 'BUSINESS_MONTHLY' as const,
    status: 'ACTIVE' as const,
    currentPeriodEnd: '2026-11-11T00:00:00Z'
  };
  const downgrade = schedulePlanChange(active, 'PREMIUM_MONTHLY');
  assert.equal(downgrade.ok, true);
  if (!downgrade.ok) return;
  const renewed = applyBillingEvent(downgrade.state, {
    id: 'renew',
    type: 'invoice.paid',
    createdAt: '2026-11-11T00:00:00Z',
    plan: 'BUSINESS_MONTHLY',
    periodEnd: '2026-12-11T00:00:00Z'
  }, new Set());
  assert.equal(renewed.state.plan, 'PREMIUM_MONTHLY');
  assert.equal(renewed.state.scheduledPlan, null);

  const monthly = { ...active, plan: 'PREMIUM_MONTHLY' as const };
  const upgrade = schedulePlanChange(monthly, 'BUSINESS_MONTHLY');
  assert.equal(upgrade.ok, false);
});

check('duplicate and out-of-order events do not rewrite state', () => {
  const first = applyBillingEvent(null, {
    id: 'same',
    type: 'checkout.completed',
    createdAt: '2026-10-11T12:00:00Z',
    plan: 'PREMIUM_MONTHLY',
    periodEnd: '2026-11-11T00:00:00Z'
  }, new Set());
  const duplicate = applyBillingEvent(first.state, {
    id: 'same',
    type: 'subscription.expired',
    createdAt: '2026-10-12T00:00:00Z'
  }, new Set(['same']));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.status, 'ACTIVE');

  const older = applyBillingEvent(first.state, {
    id: 'old',
    type: 'invoice.payment_failed',
    createdAt: '2026-10-01T00:00:00Z'
  }, new Set());
  assert.equal(older.ignored, true);
  assert.equal(older.state.status, 'ACTIVE');
});

console.log('\n■ Webhooks and ownership');

check('rejects bad, stale, and missing signatures', () => {
  const raw = '{"id":"evt","type":"invoice.paid"}';
  const secret = 'whsec_test_placeholder';
  assert.equal(verifyTestWebhook(raw, signTestWebhook(raw, secret), secret), true);
  assert.equal(verifyTestWebhook(raw, signTestWebhook(raw, 'other'), secret), false);
  assert.equal(verifyTestWebhook(raw, null, secret), false);
  assert.equal(verifyTestWebhook(raw, 'abcd', ''), false);

  const t = 1_700_000_000;
  const stripe = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${stripe}`, secret, t * 1000), true);
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${'ab'.repeat(32)}`, secret, t * 1000), false);
  assert.equal(verifyStripeSignature(raw, `t=${t - 1000},v1=${stripe}`, secret, t * 1000), false);
  assert.equal(verifyStripeSignature(raw, null, secret), false);
});

check('billing records are owned by the signed-in user and clients cannot set status', () => {
  assert.equal(billingRecordOwnedBy('user-a', 'user-a'), true);
  assert.equal(billingRecordOwnedBy('user-a', 'user-b'), false);
  assert.equal(billingRecordOwnedBy('', 'user-a'), false);
  assert.equal(clientTriedToSetBillingStatus({ plan: 'PREMIUM_MONTHLY' }), false);
  assert.equal(clientTriedToSetBillingStatus({ plan: 'PREMIUM_MONTHLY', status: 'ACTIVE' }), true);
  assert.equal(clientTriedToSetBillingStatus({ entitled: true }), true);
  const checkout = read('src/app/api/billing/checkout/route.ts');
  assert.match(checkout, /clientTriedToSetBillingStatus/);
  assert.match(checkout, /completeTestCheckout\(user\.id/);
  const premium = read('src/app/app/premium/page.tsx');
  assert.equal(premium.includes('useSearchParams'), false);
  assert.match(premium, /Simulated/);
  assert.match(premium, /action: 'complete'/);
});

check('migration is additive and does not drop chats or uploads', () => {
  const sql = read('prisma/migrations/20261011200000_premium_business/migration.sql');
  assert.match(sql, /CREATE TABLE "Subscription"/);
  assert.equal(/DROP TABLE/i.test(sql), false);
  assert.equal(/DROP COLUMN/i.test(sql), false);
});

console.log('\n■ Business verification and messaging tools');

check('verification cannot be self-approved or repeated while pending', () => {
  assert.equal(requestVerification('UNVERIFIED').ok, true);
  assert.equal(requestVerification('REJECTED').ok, true);
  assert.equal(requestVerification('PENDING').ok, false);
  assert.equal(requestVerification('APPROVED').ok, false);
  const self = reviewVerification({
    actorId: 'u1',
    actorRole: 'ADMIN',
    targetUserId: 'u1',
    decision: 'APPROVED'
  });
  assert.equal(self.ok, false);
  const user = reviewVerification({
    actorId: 'u2',
    actorRole: 'USER',
    targetUserId: 'u1',
    decision: 'APPROVED'
  });
  assert.equal(user.ok, false);
  const ok = reviewVerification({
    actorId: 'mod',
    actorRole: 'MODERATOR',
    targetUserId: 'u1',
    decision: 'REJECTED'
  });
  assert.equal(ok.ok, true);
  const admin = read('src/app/api/admin/business/route.ts');
  assert.match(admin, /requireAdmin/);
  assert.match(admin, /reviewVerification/);
});

check('business profile and quick replies are validated', () => {
  const bad = validateBusinessProfile({ name: 'Cafe', website: 'javascript:alert(1)' });
  assert.equal(bad.ok, false);
  const good = validateBusinessProfile({ name: 'Cafe', website: 'https://cafe.example', category: 'FOOD' });
  assert.equal(good.ok, true);
  assert.equal(validateQuickReply({ title: '', body: 'Hi' }).ok, false);
  assert.equal(validateQuickReply({ title: 'Hours', body: 'We open at 9.' }).ok, true);
});

check('away replies respect entitlement, blocks, self, and cooldown', () => {
  assert.equal(
    shouldSendAway({ awayEnabled: true, entitled: false, senderIsBusiness: false, blocked: false, lastAwayAt: null }),
    false
  );
  assert.equal(
    shouldSendAway({ awayEnabled: true, entitled: true, senderIsBusiness: true, blocked: false, lastAwayAt: null }),
    false
  );
  assert.equal(
    shouldSendAway({ awayEnabled: true, entitled: true, senderIsBusiness: false, blocked: true, lastAwayAt: null }),
    false
  );
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(
    shouldSendAway({
      awayEnabled: true,
      entitled: true,
      senderIsBusiness: false,
      blocked: false,
      lastAwayAt: new Date(now - 60_000),
      now
    }),
    false
  );
  assert.equal(
    shouldSendAway({
      awayEnabled: true,
      entitled: true,
      senderIsBusiness: false,
      blocked: false,
      lastAwayAt: new Date(now - 13 * 60 * 60 * 1000),
      now
    }),
    true
  );
  assert.match(read('src/app/api/conversations/route.ts'), /maybeSendGreeting/);
  assert.match(read('src/app/api/conversations/[id]/messages/route.ts'), /maybeSendAway/);
});

console.log('\n■ Existing app contracts');

check('premium and business are not a seventh bottom-nav item', () => {
  const nav = read('src/components/app/BottomNav.tsx');
  const hrefs = nav.match(/href: '\/app\/[^']+'/g) ?? [];
  assert.equal(hrefs.length, 6);
  assert.equal(nav.includes('/app/premium'), false);
  assert.equal(nav.includes('/app/business'), false);
  assert.match(read('src/app/app/layout.tsx'), /\/app\/premium/);
  assert.match(read('src/components/app/Sidebar.tsx'), /\/app\/premium/);
  assert.match(read('src/app/app/settings/page.tsx'), /\/app\/business/);
});

check('billing responses and logs do not carry card data', () => {
  const billing = read('src/lib/billing.ts');
  assert.equal(/cvv|cardNumber|pan\b/i.test(billing), false);
  assert.equal(billing.includes('console.'), false);
  const env = read('.env.example');
  assert.match(env, /BILLING_MODE=""/);
  assert.match(env, /STRIPE_SECRET_KEY=""/);
  assert.equal(env.includes('sk_live_'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
