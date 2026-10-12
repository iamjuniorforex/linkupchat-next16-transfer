/**
 * Phase 4A — call signaling state machine unit tests (src/lib/call-state.ts)
 * + stale-row reconciliation (src/lib/calls-reconcile.ts).
 *
 * Run: npm run test:calls
 */
import assert from 'node:assert/strict';
import {
  beginCall,
  acceptCall,
  endCall,
  abortCall,
  resolveCallFor,
  findCallBySocketId,
  getCallForUser,
  otherParticipant,
  sweepStaleCalls,
  setOnRingTimeout,
  resetCallState,
  activeCallCount,
  DEFAULT_RING_TIMEOUT_MS
} from '../src/lib/call-state';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
    });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('■ call-state: initiation');
  await check('default ring timeout is 45 seconds', () => {
    assert.equal(DEFAULT_RING_TIMEOUT_MS, 45_000);
  });

  await check('beginCall registers a RINGING call for both users', () => {
    resetCallState();
    const r = beginCall({ callId: 'c1', conversationId: 'conv1', callerId: 'A', calleeId: 'B', type: 'VOICE', callerSocketId: 'sockA' });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.call.phase, 'RINGING');
    assert.equal(getCallForUser('A')?.callId, 'c1');
    assert.equal(getCallForUser('B')?.callId, 'c1');
    assert.equal(activeCallCount(), 1);
  });

  await check('self-call is rejected', () => {
    resetCallState();
    const r = beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'A', type: 'VOICE' });
    assert.ok(!r.ok && r.reason === 'SELF_CALL');
    assert.equal(activeCallCount(), 0);
  });

  await check('caller already in a call → CALLER_BUSY (no second call)', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const r = beginCall({ callId: 'c2', conversationId: null, callerId: 'A', calleeId: 'C', type: 'VOICE' });
    assert.ok(!r.ok && r.reason === 'CALLER_BUSY');
    assert.equal(activeCallCount(), 1);
  });

  await check('callee already in a call → CALLEE_BUSY (no second call)', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const r = beginCall({ callId: 'c2', conversationId: null, callerId: 'C', calleeId: 'B', type: 'VOICE' });
    assert.ok(!r.ok && r.reason === 'CALLEE_BUSY');
    assert.equal(activeCallCount(), 1);
    assert.equal(getCallForUser('C'), null);
  });

  await check('retry of the same ringing offer is a dedupe, not a new call', () => {
    resetCallState();
    const first = beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const retry = beginCall({ callId: 'c2', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VIDEO' });
    assert.ok(first.ok && retry.ok);
    if (!first.ok || !retry.ok) return;
    assert.equal(retry.deduped, true);
    assert.equal(retry.call.callId, first.call.callId);
    assert.equal(activeCallCount(), 1);
  });

  await check('simultaneous attempts resolve deterministically (one winner)', () => {
    resetCallState();
    // JS single-threaded check-and-set: whatever the arrival order, exactly
    // one of two competing begins for the same callee can succeed.
    const a = beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const c = beginCall({ callId: 'c2', conversationId: null, callerId: 'C', calleeId: 'B', type: 'VOICE' });
    const wins = [a, c].filter((r) => r.ok);
    const busy = [a, c].filter((r) => !r.ok);
    assert.equal(wins.length, 1);
    assert.equal(busy.length, 1);
    assert.ok(!busy[0]!.ok && busy[0]!.reason === 'CALLEE_BUSY');
    assert.equal(activeCallCount(), 1);
  });

  console.log('\n■ call-state: accept / role / transition validity');
  await check('callee accepts → CONNECTED with server-side connect time', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const r = acceptCall({ callId: 'c1', userId: 'B', socketId: 'sockB' });
    assert.ok(r);
    assert.equal(r!.phase, 'CONNECTED');
    assert.ok(r!.connectedAt != null);
  });

  await check('caller cannot accept their own call', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    assert.equal(acceptCall({ callId: 'c1', userId: 'A' }), null);
    assert.equal(getCallForUser('A')?.phase, 'RINGING');
  });

  await check('non-participant cannot accept', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    assert.equal(acceptCall({ callId: 'c1', userId: 'X' }), null);
  });

  await check('duplicate accept is harmless (second attempt rejected)', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    assert.ok(acceptCall({ callId: 'c1', userId: 'B' }));
    assert.equal(acceptCall({ callId: 'c1', userId: 'B' }), null);
    assert.equal(getCallForUser('B')?.phase, 'CONNECTED');
  });

  await check('unknown call ids are harmless no-ops', () => {
    resetCallState();
    assert.equal(acceptCall({ callId: 'nope', userId: 'B' }), null);
    assert.equal(endCall({ callId: 'nope', userId: 'B', via: 'user' }), null);
  });

  console.log('\n■ call-state: outcomes (cancel / decline / end / missed)');
  await check('caller ends a ringing call → CANCELLED', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const r = endCall({ callId: 'c1', userId: 'A', via: 'user' });
    assert.ok(r);
    assert.equal(r!.status, 'CANCELLED');
    assert.equal(r!.reason, 'CANCELLED');
    assert.equal(r!.durationSec, 0);
    assert.equal(activeCallCount(), 0);
  });

  await check('callee ends a ringing call → DECLINED', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const r = endCall({ callId: 'c1', userId: 'B', via: 'user' });
    assert.ok(r);
    assert.equal(r!.status, 'DECLINED');
    assert.equal(activeCallCount(), 0);
  });

  await check('ending a connected call → ENDED with computed duration', async () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    acceptCall({ callId: 'c1', userId: 'B' });
    await sleep(1100);
    const r = endCall({ callId: 'c1', userId: 'A', via: 'user' });
    assert.ok(r);
    assert.equal(r!.status, 'ENDED');
    assert.equal(r!.reason, 'ENDED');
    assert.ok(r!.durationSec >= 1, `durationSec=${r!.durationSec}`);
  });

  await check('non-participant cannot end someone else\'s call', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    assert.equal(endCall({ callId: 'c1', userId: 'X', via: 'user' }), null);
    assert.equal(activeCallCount(), 1);
  });

  await check('replayed end after conclusion is harmless', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    assert.ok(endCall({ callId: 'c1', userId: 'A', via: 'user' }));
    assert.equal(endCall({ callId: 'c1', userId: 'A', via: 'user' }), null);
    assert.equal(endCall({ callId: 'c1', userId: 'B', via: 'user' }), null);
    assert.equal(activeCallCount(), 0);
  });

  console.log('\n■ call-state: disconnect / timeout / sweep');
  await check('caller disconnect while ringing → CANCELLED/DISCONNECTED', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const r = endCall({ callId: 'c1', userId: 'A', via: 'disconnect' });
    assert.ok(r);
    assert.equal(r!.status, 'CANCELLED');
    assert.equal(r!.reason, 'DISCONNECTED');
  });

  await check('callee disconnect while ringing → MISSED/DISCONNECTED', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    const r = endCall({ callId: 'c1', userId: 'B', via: 'disconnect' });
    assert.ok(r);
    assert.equal(r!.status, 'MISSED');
    assert.equal(r!.reason, 'DISCONNECTED');
  });

  await check('disconnect during a connected call → ENDED/DISCONNECTED', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    acceptCall({ callId: 'c1', userId: 'B' });
    const r = endCall({ callId: 'c1', userId: 'B', via: 'disconnect' });
    assert.ok(r);
    assert.equal(r!.status, 'ENDED');
    assert.equal(r!.reason, 'DISCONNECTED');
  });

  await check('ring timer fires → MISSED/TIMEOUT (missed call persisted)', async () => {
    resetCallState();
    let expired = '';
    setOnRingTimeout((callId) => {
      expired = callId;
      endCall({ callId, userId: '', via: 'timeout' });
    });
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE', ringTimeoutMs: 60 });
    await sleep(160);
    assert.equal(expired, 'c1');
    assert.equal(activeCallCount(), 0);
    const outcome = endCall({ callId: 'c1', userId: '', via: 'timeout' });
    assert.equal(outcome, null); // already concluded by the handler
  });

  await check('ring timer is cleared on accept', async () => {
    resetCallState();
    let fired = false;
    setOnRingTimeout(() => {
      fired = true;
    });
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE', ringTimeoutMs: 50 });
    acceptCall({ callId: 'c1', userId: 'B' });
    await sleep(120);
    assert.equal(fired, false);
    assert.equal(getCallForUser('A')?.phase, 'CONNECTED');
  });

  await check('sweep concludes stale ringing calls, leaves fresh ones', () => {
    resetCallState();
    beginCall({ callId: 'stale', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    beginCall({ callId: 'fresh', conversationId: null, callerId: 'C', calleeId: 'D', type: 'VOICE' });
    // age the first call artificially
    const stale = getCallForUser('A')!;
    stale.startedAt = Date.now() - 10 * 60_000;
    const out = sweepStaleCalls();
    assert.equal(out.length, 1);
    assert.equal(out[0]!.call.callId, 'stale');
    assert.equal(out[0]!.status, 'MISSED');
    assert.equal(out[0]!.reason, 'TIMEOUT');
    assert.equal(activeCallCount(), 1);
    assert.ok(getCallForUser('C'));
  });

  console.log('\n■ call-state: routing / ownership guards');
  await check('resolveCallFor only returns calls the user participates in', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    assert.equal(resolveCallFor('A', { callId: 'c1' })?.callId, 'c1');
    assert.equal(resolveCallFor('B', { callId: 'c1' })?.callId, 'c1');
    assert.equal(resolveCallFor('X', { callId: 'c1' }), null); // foreign call id
    assert.equal(resolveCallFor('A', { callId: 'c1', peerId: 'X' })?.callId, 'c1'); // id wins
    assert.equal(resolveCallFor('X', { peerId: 'B' }), null); // foreign pair
  });

  await check('pair fallback tolerates client temp ids (pending-…)', () => {
    resetCallState();
    beginCall({ callId: 'real-id', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE' });
    assert.equal(resolveCallFor('A', { callId: 'pending-123', peerId: 'B' })?.callId, 'real-id');
    assert.equal(resolveCallFor('B', { callId: 'pending-123', peerId: 'A' })?.callId, 'real-id');
  });

  await check('socket ownership tracking + abort rollback', () => {
    resetCallState();
    beginCall({ callId: 'c1', conversationId: null, callerId: 'A', calleeId: 'B', type: 'VOICE', callerSocketId: 'sockA' });
    assert.equal(findCallBySocketId('sockA')?.callId, 'c1');
    assert.equal(findCallBySocketId('sockB'), null);
    acceptCall({ callId: 'c1', userId: 'B', socketId: 'sockB' });
    assert.equal(findCallBySocketId('sockB')?.callId, 'c1');
    assert.equal(otherParticipant(getCallForUser('A')!, 'A'), 'B');
    abortCall('c1');
    assert.equal(activeCallCount(), 0);
    assert.equal(getCallForUser('A'), null);
    assert.equal(getCallForUser('B'), null);
  });

  // ── DB reconciliation (uses the real dev database) ──
  console.log('\n■ calls-reconcile: stale DB rows converge to final states');
  await check('orphaned RINGING/CONNECTED rows are finalized; finished rows untouched', async () => {
    const { db } = await import('../src/lib/db');
    const { reconcileStaleCallRows } = await import('../src/lib/calls-reconcile');
    const alex = await db.user.findUnique({ where: { username: 'alex' }, select: { id: true } });
    const emma = await db.user.findUnique({ where: { username: 'emma' }, select: { id: true } });
    assert.ok(alex && emma);

    const ring = await db.call.create({
      data: { callerId: alex!.id, calleeId: emma!.id, type: 'VOICE', status: 'RINGING' }
    });
    const conn = await db.call.create({
      data: { callerId: emma!.id, calleeId: alex!.id, type: 'VIDEO', status: 'CONNECTED' }
    });
    const done = await db.call.create({
      data: {
        callerId: alex!.id,
        calleeId: emma!.id,
        type: 'VOICE',
        status: 'ENDED',
        endedAt: new Date(),
        durationSec: 42
      }
    });

    const result = await reconcileStaleCallRows();
    assert.equal(result.missed >= 1, true);
    assert.equal(result.ended >= 1, true);

    const ringAfter = await db.call.findUnique({ where: { id: ring.id } });
    const connAfter = await db.call.findUnique({ where: { id: conn.id } });
    const doneAfter = await db.call.findUnique({ where: { id: done.id } });
    assert.equal(ringAfter?.status, 'MISSED');
    assert.ok(ringAfter?.endedAt, 'orphaned ringing row got endedAt');
    assert.equal(connAfter?.status, 'ENDED');
    assert.ok(connAfter?.endedAt);
    assert.equal(doneAfter?.status, 'ENDED');
    assert.equal(doneAfter?.durationSec, 42, 'finished rows untouched');

    await db.call.deleteMany({ where: { id: { in: [ring.id, conn.id, done.id] } } });
  });
}

main().then(() => {
  console.log('\n════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  process.exit(failed ? 1 : 0);
});
