/**
 * Remediation M-3 — same-tick call signaling (Socket.IO against the server).
 *
 * The connection handler used to register its event listeners after async
 * room joins, so an offer emitted in the same tick as 'connect' was silently
 * dropped. This test emits CALL_OFFER immediately after `io()` (no sleep,
 * no waiting for 'connect') and requires the callee to receive it.
 *
 * Run: npm run test:call-race   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import { api, connectSocket, createReporter, login, sleep, type Session } from './helpers';
import { EVENTS } from '../shared/events';

const report = createReporter();

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${process.env.SERVER_URL ?? 'http://localhost:3300'}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Passw0rd123', displayName, email: `${username}@example.com` })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

function capture<T = unknown>(socket: Socket, event: string): T[] {
  const items: T[] = [];
  socket.on(event, (p: T) => items.push(p));
  return items;
}

async function main() {
  console.log('■ call-race: offers emitted at connect time are never dropped');
  const stamp = Date.now().toString(36);
  const a = await register(`cr_${stamp}`, 'Call Race A');
  const b = await register(`cb_${stamp}`, 'Call Race B');
  // Calls require an active DIRECT conversation between the pair.
  const conv = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
    type: 'DIRECT',
    username: b.username
  });
  assert.equal(conv.status, 201, `DIRECT create: ${conv.status}`);

  await report.check('a CALL_OFFER emitted in the connect tick still reaches the callee', async () => {
    const bSock = connectSocket(b);
    await sleep(700); // settle B's socket (room joins)
    const bOffers = capture<{ callId: string; from: string }>(bSock, EVENTS.CALL_OFFER);

    // A emits BEFORE its socket connects — the packet is flushed in the same
    // tick as the server-side 'connection' event (the historic drop window).
    const aSock = connectSocket(a);
    aSock.emit(EVENTS.CALL_OFFER, {
      callId: `pending-race-${Date.now()}`,
      from: '',
      to: b.id,
      type: 'VOICE'
    });

    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (bOffers.some((o) => o.from === a.id)) break;
      await sleep(150);
    }
    const offer = bOffers.find((o) => o.from === a.id);
    assert.ok(offer, 'callee never received the same-tick call offer');
    assert.ok(offer.callId, 'offer must carry the server-assigned callId');

    // Clean up: end the call so state stays tidy.
    aSock.emit(EVENTS.CALL_END, { callId: offer.callId, to: b.id, durationSec: 0 });
    await sleep(300);
    aSock.close();
    bSock.close();
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
