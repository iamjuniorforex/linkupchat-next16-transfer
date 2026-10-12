/**
 * Phase 4A — call signaling e2e (Socket.IO + HTTP against a running server).
 *
 * Covers: valid initiation (server-derived caller identity), accept, reject,
 * cancel, end (server-computed duration), busy caller/recipient, simultaneous
 * attempts, unauthorized & cross-user signaling, blocked users, invalid call
 * ids, duplicate/replayed events, invalid transitions, disconnect cleanup,
 * ring timeout → missed-call persistence.
 *
 * Run: npm run test:calls:e2e   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import {
  api,
  connectSocket,
  createReporter,
  login,
  sleep,
  waitFor,
  type Session
} from './helpers';
import { EVENTS } from '../shared/events';

const report = createReporter();
const RING_WAIT_MS = 50_000; // > the 45s ring timeout

interface OfferPayload {
  callId: string;
  from: string;
  fromName?: string;
  fromUsername?: string;
  to: string;
  type: string;
  sdp?: { type?: string; sdp?: string } | null;
  outgoing?: boolean;
}
interface EndPayload {
  callId: string;
  from: string;
  durationSec: number;
  reason?: string;
}
interface BusyPayload {
  callId: string | null;
  from: string;
  to: string;
  reason: string;
}

function capture<T = unknown>(socket: Socket, event: string): T[] {
  const items: T[] = [];
  socket.on(event, (p: T) => items.push(p));
  return items;
}

function emitOffer(
  socket: Socket,
  args: { fromSpoof?: string; to: string; type?: 'VOICE' | 'VIDEO'; callId?: string }
) {
  socket.emit(EVENTS.CALL_OFFER, {
    callId: args.callId ?? `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: args.fromSpoof ?? '',
    to: args.to,
    type: args.type ?? 'VOICE',
    sdp: { type: 'offer', sdp: 'v=0-fake' }
  });
}

interface CallRow {
  id: string;
  status: string;
  type: string;
  direction: 'OUTGOING' | 'INCOMING';
  peer: { id: string; username?: string } | null;
  conversationId?: string | null;
  durationSec: number;
  endedAt: string | null;
}

async function callsList(s: Session): Promise<CallRow[]> {
  const res = await api<{ data?: { calls?: CallRow[] } }>(s, 'GET', '/api/calls');
  assert.equal(res.status, 200);
  return res.json.data?.calls ?? [];
}

async function main() {
  const alex = await login('alex'); // caller
  const emma = await login('emma'); // callee
  const sarah = await login('sarah'); // third user / attacker
  const daniel = await login('daniel'); // blocked pair

  // The call relationship rule requires an active DIRECT conversation — make
  // sure sarah↔emma have one so the busy/simultaneous cases are reachable.
  await api(sarah, 'POST', '/api/conversations', { type: 'DIRECT', username: 'emma' });

  let aSock = connectSocket(alex);
  let eSock = connectSocket(emma);
  const sSock = connectSocket(sarah);
  const dSock = connectSocket(daniel);
  await sleep(400);

  const aOffers = capture<OfferPayload>(aSock, EVENTS.CALL_OFFER);
  const eOffers = capture<OfferPayload>(eSock, EVENTS.CALL_OFFER);
  const aAnswers = capture<{ callId: string; accepted?: boolean }>(aSock, EVENTS.CALL_ANSWER);
  const aRejects = capture<{ callId: string; from: string }>(aSock, EVENTS.CALL_REJECT);
  const aEnds = capture<EndPayload>(aSock, EVENTS.CALL_END);
  const eEnds = capture<EndPayload>(eSock, EVENTS.CALL_END);
  const aBusy = capture<BusyPayload>(aSock, EVENTS.CALL_BUSY);
  const cBusy = capture<BusyPayload>(sSock, EVENTS.CALL_BUSY);
  const eIce = capture<{ callId: string; from: string; to: string; candidate: unknown }>(eSock, EVENTS.CALL_ICE);
  const sOffers = capture<OfferPayload>(sSock, EVENTS.CALL_OFFER);
  const dOffers = capture<OfferPayload>(dSock, EVENTS.CALL_OFFER);
  const sAnswers = capture<unknown>(sSock, EVENTS.CALL_ANSWER);
  const sEnds = capture<EndPayload>(sSock, EVENTS.CALL_END);
  const dEnds = capture<EndPayload>(dSock, EVENTS.CALL_END);

  // ── 1. Valid initiation: server-derived identity, accept, end, persistence ──
  {
    emitOffer(aSock, { to: emma.id, type: 'VOICE', fromSpoof: 'evil-user-999' });
    await sleep(400);
    await report.check('valid initiation: callee receives the offer with caller identity from the SESSION (spoofed "from" ignored)', () => {
      assert.equal(eOffers.length, 1, `callee offers=${eOffers.length}`);
      const o = eOffers[0]!;
      assert.equal(o.from, alex.id, `from=${o.from}`);
      assert.equal(o.to, emma.id);
      assert.equal(o.type, 'VOICE');
      assert.ok(o.callId && !o.callId.startsWith('pending-'), `callId=${o.callId}`);
      assert.ok(o.fromName, 'fromName present');
    });
    await report.check('valid initiation: caller receives an echo with the authoritative call id', () => {
      const o = aOffers.find((x) => x.outgoing);
      assert.ok(o, 'no echo');
      assert.equal(o!.callId, eOffers[0]!.callId);
      assert.equal(o!.to, emma.id);
    });

    const list = await callsList(alex);
    const row = list.find((c) => c.id === eOffers[0]!.callId);
    await report.check('call persistence: RINGING row with server-derived caller + conversationId', () => {
      assert.ok(row, 'row missing');
      assert.equal(row!.status, 'RINGING');
      assert.equal(row!.direction, 'OUTGOING', 'alex is the caller (server-derived)');
      assert.equal(row!.peer?.id, emma.id);
      assert.ok(row!.conversationId, 'conversationId populated');
    });

    eSock.emit(EVENTS.CALL_ACCEPT, { callId: eOffers[0]!.callId, sdp: { type: 'answer', sdp: 'v=0-fake-a' } });
    await sleep(400);
    await report.check('accept: caller receives the answer; row becomes CONNECTED', async () => {
      assert.equal(aAnswers.length, 1, `answers=${aAnswers.length}`);
      assert.equal(aAnswers[0]!.callId, eOffers[0]!.callId);
      assert.equal(aAnswers[0]!.accepted, true);
      const r = (await callsList(alex)).find((c) => c.id === eOffers[0]!.callId);
      assert.equal(r?.status, 'CONNECTED');
    });

    // ICE routing: spoofed "from" is ignored, payload.to is not trusted for routing
    aSock.emit(EVENTS.CALL_ICE, {
      callId: eOffers[0]!.callId,
      from: 'evil-user-999',
      to: emma.id,
      candidate: { candidate: 'candidate:1', sdpMid: '0' }
    });
    await sleep(300);
    await report.check('ICE relays between the real participants only (identity server-derived)', () => {
      assert.equal(eIce.length, 1);
      assert.equal(eIce[0]!.from, alex.id, `from=${eIce[0]!.from}`);
      assert.equal(eIce[0]!.to, emma.id);
      assert.equal(eIce[0]!.callId, eOffers[0]!.callId);
    });

    await sleep(1100); // guarantee ≥1s of connected time
    aSock.emit(EVENTS.CALL_END, {
      callId: eOffers[0]!.callId,
      to: emma.id,
      durationSec: 99999 // forged — must be ignored
    });
    await sleep(400);
    await report.check('end: peer notified with server-computed duration (forged duration ignored)', async () => {
      assert.equal(eEnds.length, 1);
      const e = eEnds[0]!;
      assert.equal(e.callId, eOffers[0]!.callId);
      assert.equal(e.reason, 'ENDED');
      assert.ok(e.durationSec >= 1 && e.durationSec < 60, `durationSec=${e.durationSec}`);
      const r = (await callsList(emma)).find((c) => c.id === eOffers[0]!.callId);
      assert.equal(r?.status, 'ENDED');
      assert.ok(r?.endedAt, 'endedAt set');
    });
  }

  // ── 2. Reject ──
  {
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const callId = eOffers[eOffers.length - 1]!.callId;
    eSock.emit(EVENTS.CALL_REJECT, { callId, to: alex.id });
    await sleep(350);
    await report.check('reject: callee refusal → caller gets declined; row DECLINED', async () => {
      assert.equal(aRejects.length, 1);
      assert.equal(aRejects[0]!.from, emma.id);
      const r = (await callsList(alex)).find((c) => c.id === callId);
      assert.equal(r?.status, 'DECLINED');
    });
  }

  // ── 3. Caller cancel while ringing ──
  {
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const callId = eOffers[eOffers.length - 1]!.callId;
    aSock.emit(EVENTS.CALL_END, { callId, to: emma.id });
    await sleep(350);
    await report.check('cancel: caller abandons ringing → callee gets CANCELLED; row CANCELLED', async () => {
      const e = eEnds[eEnds.length - 1]!;
      assert.equal(e.reason, 'CANCELLED', `reason=${e.reason}`);
      const r = (await callsList(alex)).find((c) => c.id === callId);
      assert.equal(r?.status, 'CANCELLED');
    });
  }

  // ── 4. Callee ending a ringing call == refusal ──
  {
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const callId = eOffers[eOffers.length - 1]!.callId;
    eSock.emit(EVENTS.CALL_END, { callId, to: alex.id });
    await sleep(350);
    await report.check('callee ending a ringing call is a refusal (declined event + DECLINED row)', async () => {
      assert.equal(aRejects.length, 2, `rejects=${aRejects.length}`);
      const r = (await callsList(alex)).find((c) => c.id === callId);
      assert.equal(r?.status, 'DECLINED');
    });
  }

  // ── 5. Busy recipient ──
  {
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const ringId = eOffers[eOffers.length - 1]!.callId;
    emitOffer(sSock, { to: emma.id });
    await sleep(350);
    await report.check('busy recipient: second caller gets CALL_BUSY, no offer reaches the callee', () => {
      assert.equal(cBusy.length, 1, `busy=${cBusy.length}`);
      assert.equal(cBusy[0]!.reason, 'CALLEE_BUSY');
      assert.equal(cBusy[0]!.from, sarah.id);
      assert.equal(cBusy[0]!.to, emma.id);
      assert.equal(sOffers.filter((o) => o.outgoing).length, 0, 'busy attempt receives no offer echo');
      assert.equal(eOffers.filter((o) => o.from === sarah.id).length, 0, 'no offer for sarah reached the callee');
    });
    await report.check('busy attempt creates no Call row', async () => {
      const rows = (await callsList(sarah)).filter((c) => c.status === 'RINGING');
      assert.equal(rows.length, 0, `sarah ringing rows=${rows.length}`);
      const r = (await callsList(alex)).find((c) => c.id === ringId);
      assert.equal(r?.status, 'RINGING', 'original call unaffected');
    });
    aSock.emit(EVENTS.CALL_END, { callId: ringId, to: emma.id });
    await sleep(300);
  }

  // ── 6. Busy caller (ringing + connected) ──
  {
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const ringId = eOffers[eOffers.length - 1]!.callId;
    emitOffer(aSock, { to: daniel.id });
    await sleep(350);
    await report.check('busy caller: a user in a call cannot start another (CALLER_BUSY, callee undisturbed)', () => {
      assert.equal(aBusy.length, 1);
      assert.equal(aBusy[0]!.reason, 'CALLER_BUSY');
      assert.equal(aBusy[0]!.to, daniel.id);
      assert.equal(dOffers.length, 0, 'daniel must not be rung');
    });
    aSock.emit(EVENTS.CALL_END, { callId: ringId, to: emma.id });
    await sleep(300);

    // busy while CONNECTED
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const connId = eOffers[eOffers.length - 1]!.callId;
    eSock.emit(EVENTS.CALL_ACCEPT, { callId: connId, sdp: null });
    await sleep(350);
    emitOffer(sSock, { to: emma.id });
    await sleep(350);
    await report.check('busy recipient while CONNECTED also rejects new attempts', () => {
      assert.equal(cBusy.length, 2, `busy=${cBusy.length}`);
      assert.equal(cBusy[1]!.reason, 'CALLEE_BUSY');
    });
    aSock.emit(EVENTS.CALL_END, { callId: connId, to: emma.id });
    await sleep(300);
  }

  // ── 7. Simultaneous attempts → deterministic single winner ──
  {
    const aBusyBefore = aBusy.length;
    const cBusyBefore = cBusy.length;
    emitOffer(aSock, { to: emma.id });
    emitOffer(sSock, { to: emma.id });
    await sleep(500);
    await report.check('simultaneous attempts: exactly one ringing call wins the callee', async () => {
      const rows = (await callsList(emma)).filter((c) => c.status === 'RINGING' && c.direction === 'INCOMING');
      assert.equal(rows.length, 1, `ringing rows=${rows.length}`);
      const busyDeltas = aBusy.length - aBusyBefore + (cBusy.length - cBusyBefore);
      assert.equal(busyDeltas, 1, `busy deltas=${busyDeltas} (alex ${aBusy.length - aBusyBefore}, sarah ${cBusy.length - cBusyBefore})`);
    });
    // cleanup: end whichever won
    const live = (await callsList(alex)).find((c) => c.status === 'RINGING');
    const liveForSarah = (await callsList(sarah)).find((c) => c.status === 'RINGING');
    const winner = live ?? liveForSarah;
    if (winner) {
      const sock = live ? aSock : sSock;
      sock.emit(EVENTS.CALL_END, { callId: winner.id, to: emma.id });
      await sleep(300);
    }
  }

  // ── 8. Unauthorized / cross-user signaling is inert ──
  {
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const callId = eOffers[eOffers.length - 1]!.callId;
    const aAnswersBefore = aAnswers.length;

    sSock.emit(EVENTS.CALL_ACCEPT, { callId, sdp: { type: 'answer', sdp: 'evil' } });
    sSock.emit(EVENTS.CALL_REJECT, { callId, to: alex.id });
    sSock.emit(EVENTS.CALL_END, { callId, to: alex.id, durationSec: 1 });
    sSock.emit(EVENTS.CALL_ICE, { callId, to: emma.id, candidate: { candidate: 'evil' } });
    await sleep(450);

    await report.check('cross-user manipulation: accept/reject/end/ICE by a stranger are all inert', async () => {
      assert.equal(aAnswers.length, aAnswersBefore, 'stranger accept produced an answer');
      assert.equal(eIce.filter((x) => x.from === sarah.id).length, 0, 'stranger ICE was relayed');
      const r = (await callsList(alex)).find((c) => c.id === callId);
      assert.equal(r?.status, 'RINGING', `row moved to ${r?.status}`);
    });

    // the real participants still control it
    eSock.emit(EVENTS.CALL_ACCEPT, { callId, sdp: null });
    await sleep(350);
    await report.check('real participants retain full control afterwards', async () => {
      const r = (await callsList(alex)).find((c) => c.id === callId);
      assert.equal(r?.status, 'CONNECTED');
    });
    aSock.emit(EVENTS.CALL_END, { callId, to: emma.id });
    await sleep(300);
  }

  // ── 9. Invalid call ids + invalid transitions + duplicates ──
  {
    // garbage ids are harmless and the server keeps working
    eSock.emit(EVENTS.CALL_ACCEPT, { callId: 'nope-not-a-call', sdp: null });
    eSock.emit(EVENTS.CALL_REJECT, { callId: 'nope-not-a-call', to: alex.id });
    aSock.emit(EVENTS.CALL_END, { callId: 'nope-not-a-call', to: emma.id });
    aSock.emit(EVENTS.CALL_ICE, { callId: 'nope-not-a-call', to: emma.id, candidate: null });
    await sleep(300);

    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const callId = eOffers[eOffers.length - 1]!.callId;

    // duplicate offer retry reuses the same call
    emitOffer(aSock, { to: emma.id, callId: 'pending-retry-1' });
    await sleep(350);
    await report.check('replayed offer is deduped: same call id, still one call', async () => {
      const echoes = aOffers.filter((o) => o.outgoing);
      assert.equal(echoes[echoes.length - 1]!.callId, callId, 'retry got a different id');
      const ringing = (await callsList(alex)).filter((c) => c.status === 'RINGING');
      assert.equal(ringing.length, 1);
    });

    const answersBefore = aAnswers.length;
    eSock.emit(EVENTS.CALL_ACCEPT, { callId, sdp: null });
    eSock.emit(EVENTS.CALL_ACCEPT, { callId, sdp: null }); // duplicate
    await sleep(400);
    await report.check('duplicate accept is harmless (exactly one answer)', () => {
      assert.equal(aAnswers.length, answersBefore + 1, `answers=${aAnswers.length - answersBefore}`);
    });

    // invalid transition: decline after connect must not change anything
    eSock.emit(EVENTS.CALL_REJECT, { callId, to: alex.id });
    await sleep(350);
    await report.check('invalid transition (reject after connect) is rejected', async () => {
      const r = (await callsList(alex)).find((c) => c.id === callId);
      assert.equal(r?.status, 'CONNECTED', `row moved to ${r?.status}`);
    });

    const endsBefore = eEnds.length;
    aSock.emit(EVENTS.CALL_END, { callId, to: emma.id });
    aSock.emit(EVENTS.CALL_END, { callId, to: emma.id }); // replay
    await sleep(400);
    await report.check('replayed end is harmless (exactly one end event, row final)', async () => {
      assert.equal(eEnds.length, endsBefore + 1, `end events=${eEnds.length - endsBefore}`);
      const r = (await callsList(alex)).find((c) => c.id === callId);
      assert.equal(r?.status, 'ENDED');
    });
  }

  // ── 10. Blocks + invalid targets ──
  {
    await api(alex, 'POST', '/api/users/daniel/block', { blocked: true });
    emitOffer(aSock, { to: daniel.id });
    await sleep(400);
    emitOffer(dSock, { to: alex.id });
    await sleep(400);
    await report.check('blocked pair: offers in either direction are refused silently', async () => {
      assert.equal(dOffers.length, 0, 'blocked callee was rung');
      assert.equal(aOffers.filter((o) => o.from === daniel.id).length, 0, 'blocked caller reached the target');
      const rows = (await callsList(alex)).filter((c) => c.status === 'RINGING');
      assert.equal(rows.length, 0, 'no rows for blocked attempts');
    });
    await api(alex, 'POST', '/api/users/daniel/block', { blocked: false });

    emitOffer(aSock, { to: alex.id }); // self-call
    emitOffer(aSock, { to: 'ghost-user-id-xyz' }); // invalid target
    await sleep(350);
    await report.check('self-calls and invalid targets are refused', () => {
      assert.equal(aOffers.filter((o) => o.outgoing && o.to === alex.id).length, 0);
      assert.equal(aOffers.filter((o) => o.to === 'ghost-user-id-xyz').length, 0);
    });
  }

  // ── 11. Disconnect cleanup ──
  {
    // connected call, caller's socket dies
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const callId = eOffers[eOffers.length - 1]!.callId;
    eSock.emit(EVENTS.CALL_ACCEPT, { callId, sdp: null });
    await sleep(350);
    const endsBefore = eEnds.length;
    aSock.disconnect();
    await sleep(600);
    await report.check('disconnect during a connected call → peer notified, row ENDED', async () => {
      assert.equal(eEnds.length, endsBefore + 1);
      assert.equal(eEnds[eEnds.length - 1]!.reason, 'DISCONNECTED', `reason=${eEnds[eEnds.length - 1]!.reason}`);
      const r = (await callsList(emma)).find((c) => c.id === callId);
      assert.equal(r?.status, 'ENDED');
    });
    aSock = connectSocket(alex);
    await sleep(400);

    // ringing call, caller's socket dies
    const ringEndsBefore = eEnds.length;
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const ringId = eOffers[eOffers.length - 1]!.callId;
    aSock.disconnect();
    await sleep(600);
    await report.check('disconnect while ringing → callee notified (CANCELLED), row final', async () => {
      assert.equal(eEnds.length, ringEndsBefore + 1);
      assert.equal(eEnds[eEnds.length - 1]!.reason, 'DISCONNECTED');
      const r = (await callsList(emma)).find((c) => c.id === ringId);
      assert.equal(r?.status, 'CANCELLED', `status=${r?.status}`);
    });
    aSock = connectSocket(alex);
    await sleep(400);
  }

  // ── 12. Ring timeout → missed call (45s) ──
  {
    const t0 = Date.now();
    emitOffer(aSock, { to: emma.id });
    await sleep(350);
    const callId = eOffers[eOffers.length - 1]!.callId;
    await report.check('timeout: both sides receive the timeout end event after the 45s ring', async () => {
      const [aEnd, eEnd] = await Promise.all([
        waitFor<EndPayload>(aSock, EVENTS.CALL_END, RING_WAIT_MS),
        waitFor<EndPayload>(eSock, EVENTS.CALL_END, RING_WAIT_MS)
      ]);
      assert.equal(aEnd.reason, 'TIMEOUT', `caller reason=${aEnd.reason}`);
      assert.equal(eEnd.reason, 'TIMEOUT', `callee reason=${eEnd.reason}`);
      assert.equal(aEnd.callId, callId);
      const elapsed = (Date.now() - t0) / 1000;
      assert.ok(elapsed >= 44 && elapsed < 52, `ring lasted ${elapsed.toFixed(1)}s`);
    });
    await report.check('missed call is persisted (status MISSED with endedAt)', async () => {
      const r = (await callsList(alex)).find((c) => c.id === callId);
      assert.equal(r?.status, 'MISSED', `status=${r?.status}`);
      assert.ok(r?.endedAt, 'endedAt set');
      assert.equal(r?.durationSec, 0);
    });
  }

  aSock.disconnect();
  eSock.disconnect();
  sSock.disconnect();
  dSock.disconnect();
}

main()
  .then(() => {
    report.finish();
  })
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
