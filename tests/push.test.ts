/**
 * Phase 3 — Web Push delivery unit tests (mocked provider transport).
 *
 * Covers the delivery contract without any network or browser:
 *  - missing VAPID configuration → NEVER claims a send (honest failure);
 *  - successful provider invocation through the injected transport;
 *  - provider failures (5xx / throw) reported honestly, rows kept;
 *  - permanently invalid endpoints (404/410) removed from storage;
 *  - multiple subscriptions/devices fan out once per endpoint;
 *  - notification-preference gating (notifMessages/notifGroups/notifCalls);
 *  - endpoint cleanup is scoped to the owner (never another user's row).
 *
 * Run: npm run test:push   (DATABASE_URL from .env; no app server needed)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReporter } from './helpers';

const report = createReporter();

function loadDbEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const env = process.env as Record<string, string | undefined>;

async function main() {
  loadDbEnv();
  const { db } = await import('../src/lib/db');
  const push = await import('../src/lib/push');
  const webpushMod = await import('web-push');
  const webpush = (webpushMod as unknown as { default?: typeof webpushMod }).default ?? webpushMod;

  // ── Fixture users + subscriptions ────────────────────────────────────────
  const stamp = Date.now().toString(36);
  const userA = await db.user.create({
    data: {
      username: `pusha_${stamp}`,
      displayName: 'Push A',
      passwordHash: 'x'
    }
  });
  const userB = await db.user.create({
    data: {
      username: `pushb_${stamp}`,
      displayName: 'Push B',
      passwordHash: 'x'
    }
  });

  const mkSub = (userId: string, endpoint: string) =>
    db.pushSubscription.create({
      data: {
        userId,
        endpoint,
        p256dh: 'BPtest-public-key-value-aaaaaaaaaaaaaaaaaaaaaaaaaaa',
        auth: 'dGVzdGF1dGhzZWNyZXQ'
      }
    });

  const endpointA1 = `https://push.example.test/a1_${stamp}`;
  const endpointA2 = `https://push.example.test/a2_${stamp}`;
  const endpointB1 = `https://push.example.test/b1_${stamp}`;

  await mkSub(userA.id, endpointA1);
  await mkSub(userA.id, endpointA2);
  await mkSub(userB.id, endpointB1);

  type Call = { endpoint: string; payload: Record<string, unknown> };
  let calls: Call[] = [];
  let mode: 'ok' | 'fail' | 'gone' | 'throw' = 'ok';
  const transport = async (subscription: { endpoint: string }, payloadJson: string) => {
    calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(payloadJson) });
    if (mode === 'throw') throw new Error('socket hang up');
    if (mode === 'fail') return { statusCode: 500 };
    if (mode === 'gone') return { statusCode: 410 };
    return { statusCode: 201 };
  };
  push.setPushTransportForTests(transport);

  // ── Missing VAPID configuration ─────────────────────────────────────────
  await report.check('without VAPID credentials nothing is sent and nothing claims success', async () => {
    push.setPushTransportForTests(null);
    const saved = {
      pub: env.VAPID_PUBLIC_KEY,
      priv: env.VAPID_PRIVATE_KEY,
      sub: env.VAPID_SUBJECT
    };
    env.VAPID_PUBLIC_KEY = undefined;
    env.VAPID_PRIVATE_KEY = undefined;
    env.VAPID_SUBJECT = undefined;
    try {
      assert.equal(push.isPushConfigured(), false);
      const res = await push.sendWebPush(
        { endpoint: endpointA1, keys: { p256dh: 'p', auth: 'a' } },
        { title: 't' }
      );
      assert.equal(res.sent, false);
      assert.match(res.reason ?? '', /VAPID/i);

      calls = [];
      const summary = await push.dispatchPush({
        userId: userA.id,
        kind: 'MESSAGE',
        title: 'Hello',
        body: 'World'
      });
      assert.equal(summary.delivered, 0);
      assert.equal(summary.skipped, 'not-configured');
      assert.equal(calls.length, 0);
    } finally {
      env.VAPID_PUBLIC_KEY = saved.pub;
      env.VAPID_PRIVATE_KEY = saved.priv;
      env.VAPID_SUBJECT = saved.sub;
      push.setPushTransportForTests(transport);
    }
  });

  await report.check('invalid VAPID keys disable push instead of crashing', async () => {
    const saved = { pub: env.VAPID_PUBLIC_KEY, priv: env.VAPID_PRIVATE_KEY };
    env.VAPID_PUBLIC_KEY = 'not-a-valid-key';
    env.VAPID_PRIVATE_KEY = 'not-a-valid-key';
    try {
      assert.equal(push.isPushConfigured(), false);
    } finally {
      env.VAPID_PUBLIC_KEY = saved.pub;
      env.VAPID_PRIVATE_KEY = saved.priv;
    }
  });

  await report.check('valid VAPID keys are accepted (isPushConfigured)', async () => {
    const keys = webpush.generateVAPIDKeys();
    const saved = {
      pub: env.VAPID_PUBLIC_KEY,
      priv: env.VAPID_PRIVATE_KEY,
      sub: env.VAPID_SUBJECT
    };
    env.VAPID_PUBLIC_KEY = keys.publicKey;
    env.VAPID_PRIVATE_KEY = keys.privateKey;
    env.VAPID_SUBJECT = 'mailto:test@example.test';
    try {
      assert.equal(push.isPushConfigured(), true);
    } finally {
      env.VAPID_PUBLIC_KEY = saved.pub;
      env.VAPID_PRIVATE_KEY = saved.priv;
      env.VAPID_SUBJECT = saved.sub;
    }
  });

  // ── Delivery fan-out ─────────────────────────────────────────────────────
  await report.check('successful provider invocation delivers once per device', async () => {
    calls = [];
    mode = 'ok';
    const summary = await push.dispatchPush({
      userId: userA.id,
      kind: 'MESSAGE',
      title: 'Ada',
      body: 'New message',
      data: { url: '/app/chats/abc' },
      tag: 'abc'
    });
    assert.equal(summary.delivered, 2);
    assert.equal(summary.failed, 0);
    assert.equal(summary.removed, 0);
    assert.equal(summary.skipped, null);
    assert.equal(calls.length, 2);
    const endpoints = new Set(calls.map((c) => c.endpoint));
    assert.equal(endpoints.has(endpointA1), true);
    assert.equal(endpoints.has(endpointA2), true);
    // Payload carries the privacy-filtered body + deep link + coalescing tag.
    const payload = calls[0]!.payload as { title: string; body: string; data: { url: string }; tag: string };
    assert.equal(payload.title, 'Ada');
    assert.equal(payload.body, 'New message');
    assert.equal(payload.data.url, '/app/chats/abc');
    assert.equal(payload.tag, 'abc');
    // Never another user's devices.
    assert.equal([...endpoints].some((e) => e === endpointB1), false);
  });

  await report.check('provider failure is reported honestly and rows are kept', async () => {
    calls = [];
    mode = 'fail';
    const summary = await push.dispatchPush({ userId: userA.id, kind: 'MESSAGE', title: 'x' });
    assert.equal(summary.delivered, 0);
    assert.equal(summary.failed, 2);
    assert.equal(summary.removed, 0);
    const remaining = await db.pushSubscription.count({ where: { userId: userA.id } });
    assert.equal(remaining, 2);
    mode = 'ok';
  });

  await report.check('transport errors never report success', async () => {
    calls = [];
    mode = 'throw';
    const res = await push.sendWebPush(
      { endpoint: endpointA1, keys: { p256dh: 'p', auth: 'a' } },
      { title: 't' }
    );
    assert.equal(res.sent, false);
    mode = 'ok';
  });

  await report.check('410 endpoints are removed — only the owner’s row', async () => {
    calls = [];
    mode = 'gone';
    const summary = await push.dispatchPush({ userId: userA.id, kind: 'MESSAGE', title: 'x' });
    assert.equal(summary.removed, 2);
    assert.equal(summary.delivered, 0);
    const aRemaining = await db.pushSubscription.count({ where: { userId: userA.id } });
    const bRemaining = await db.pushSubscription.count({ where: { userId: userB.id } });
    assert.equal(aRemaining, 0);
    assert.equal(bRemaining, 1);
    mode = 'ok';
  });

  // Re-add one sub for A for the preference tests.
  await mkSub(userA.id, endpointA1);
  calls = [];

  await report.check('notification preferences gate push (messages/groups/calls)', async () => {
    await db.userSettings.upsert({
      where: { userId: userA.id },
      update: { notifMessages: false, notifGroups: true, notifCalls: true },
      create: { userId: userA.id, notifMessages: false, notifGroups: true, notifCalls: true }
    });
    calls = [];
    let summary = await push.dispatchPush({ userId: userA.id, kind: 'MESSAGE', title: 'x' });
    assert.equal(summary.skipped, 'disabled');
    assert.equal(calls.length, 0);

    summary = await push.dispatchPush({ userId: userA.id, kind: 'REACTION', title: 'x' });
    assert.equal(summary.skipped, 'disabled');
    assert.equal(calls.length, 0);

    summary = await push.dispatchPush({ userId: userA.id, kind: 'GROUP_MESSAGE', title: 'x' });
    assert.equal(summary.delivered, 1);
    assert.equal(calls.length, 1);

    await db.userSettings.update({
      where: { userId: userA.id },
      data: { notifGroups: false, notifCalls: false }
    });
    calls = [];
    summary = await push.dispatchPush({ userId: userA.id, kind: 'GROUP_MESSAGE', title: 'x' });
    assert.equal(summary.skipped, 'disabled');
    summary = await push.dispatchPush({ userId: userA.id, kind: 'CALL', title: 'x' });
    assert.equal(summary.skipped, 'disabled');
    assert.equal(calls.length, 0);
    // Restore
    await db.userSettings.update({
      where: { userId: userA.id },
      data: { notifMessages: true, notifGroups: true, notifCalls: true }
    });
  });

  await report.check('no subscriptions → skipped, nothing sent', async () => {
    const stranger = await db.user.create({
      data: { username: `pushc_${stamp}`, displayName: 'Push C', passwordHash: 'x' }
    });
    calls = [];
    const summary = await push.dispatchPush({ userId: stranger.id, kind: 'MESSAGE', title: 'x' });
    assert.equal(summary.skipped, 'no-subscriptions');
    assert.equal(calls.length, 0);
    await db.user.delete({ where: { id: stranger.id } });
  });

  // ── Cleanup fixture ─────────────────────────────────────────────────────
  await db.pushSubscription.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
  await db.userSettings.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  push.setPushTransportForTests(null);

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
