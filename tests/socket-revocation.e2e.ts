/**
 * Remediation — stale socket after session revocation (audit MEDIUM #1).
 *
 * A socket authenticates at connect time; before this fix a session revoked
 * later (logout / password change / session revoke / suspend) left the live
 * socket receiving `message:new` and `notification:new` indefinitely. The
 * server must invalidate the socket server-side — not rely on the client.
 *
 * Verifies: valid connect; realtime delivery; revoke-exact-session →
 * disconnect + no further message/notification events; sibling session keeps
 * working; revoked cookie cannot reconnect; revoke-all-others keeps only the
 * current socket; password change kills every socket; logout kills its socket;
 * admin suspend kills sockets.
 *
 * Run: npm run test:socket-revocation   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import {
  api,
  connectSocket,
  createReporter,
  expectQuiet,
  login,
  sleep,
  waitFor,
  type Session
} from './helpers';

const report = createReporter();
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Passw0rd123',
      displayName,
      email: `${username}@example.com`
    })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function connectAndWait(s: Session): Promise<Socket> {
  const sock = connectSocket(s);
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('connect_error', reject);
  });
  return sock;
}

async function currentSessionId(s: Session): Promise<string> {
  const res = await api<{ data?: { sessions?: { id: string; current: boolean }[] } }>(
    s,
    'GET',
    '/api/auth/sessions'
  );
  const current = (res.json.data?.sessions ?? []).find((x) => x.current);
  assert.ok(current, 'current session not listed');
  return current.id;
}

async function sendMessage(from: Session, conversationId: string, content: string) {
  const res = await api(from, 'POST', `/api/conversations/${conversationId}/messages`, {
    type: 'TEXT',
    content
  });
  assert.equal(res.status, 201, `send failed: ${res.status}`);
}

async function main() {
  console.log('■ socket-revocation: revoked sessions lose realtime access immediately');
  const stamp = Date.now().toString(36);

  const a = await register(`sr_a${stamp}`, 'Socket Revoke A');
  const peer = await register(`sr_p${stamp}`, 'Socket Revoke P');

  const convRes = await api<{ data?: { conversation?: { id?: string } } }>(
    a,
    'POST',
    '/api/conversations',
    { type: 'DIRECT', username: peer.username }
  );
  const convId = convRes.json.data?.conversation?.id;
  assert.ok(convId, 'DM not created');

  // Two SEPARATE sessions (devices) for user A, one for the peer.
  const a2 = await login(a.username, 'Passw0rd123');
  const s1 = await connectAndWait(a); // device 1 — the session we will revoke
  const s2 = await connectAndWait(a2); // device 2 — must survive revocation of s1
  const sp = await connectAndWait(peer);

  await report.check('valid socket connects', async () => {
    assert.ok(s1.connected && s2.connected && sp.connected);
  });

  await report.check('valid session receives realtime message', async () => {
    const got = waitFor(s1, 'message:new');
    await sendMessage(peer, convId, 'hello-1');
    await got;
  });

  const sidA = await currentSessionId(a); // s1's session (requests made with a's cookie)

  await report.check('revoking that exact session disconnects its socket', async () => {
    const disconnected = waitFor(s1, 'disconnect', 5000);
    const res = await api(a2, 'DELETE', '/api/auth/sessions', { sessionId: sidA });
    assert.equal(res.status, 200);
    await disconnected;
    assert.equal(s1.disconnected, true);
  });

  await report.check('no subsequent message:new reaches the revoked socket', async () => {
    await sendMessage(peer, convId, 'hello-2');
    assert.equal(await expectQuiet(s1, 'message:new', 1500), true, 'revoked socket got message:new');
    assert.equal(s1.disconnected, true);
  });

  await report.check('no subsequent notification:new reaches the revoked socket', async () => {
    await sendMessage(peer, convId, 'hello-3');
    assert.equal(
      await expectQuiet(s1, 'notification:new', 1500),
      true,
      'revoked socket got notification:new'
    );
  });

  await report.check('another valid session of the same user keeps receiving', async () => {
    const got = waitFor(s2, 'message:new');
    await sendMessage(peer, convId, 'hello-4');
    await got;
  });

  await report.check('a revoked session cannot reconnect (auth refused)', async () => {
    const retry = connectSocket(a);
    const err = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('TIMEOUT'), 5000);
      retry.once('connect_error', (e) => {
        clearTimeout(timer);
        resolve(e.message);
      });
      retry.once('connect', () => {
        clearTimeout(timer);
        resolve('CONNECTED');
      });
    });
    retry.close();
    assert.notEqual(err, 'CONNECTED', 'revoked session reconnected');
    assert.notEqual(err, 'TIMEOUT', 'no connect_error observed');
  });

  await report.check('revoke-all-others: only the current session socket survives', async () => {
    const a3 = await login(a.username, 'Passw0rd123');
    const s3 = await connectAndWait(a3);
    const d3 = waitFor(s3, 'disconnect', 5000);
    const res = await api(a2, 'DELETE', '/api/auth/sessions', { allOthers: true });
    assert.equal(res.status, 200);
    await d3;
    assert.equal(s3.disconnected, true);

    // The current device (s2 / a2) must be untouched.
    const got = waitFor(s2, 'message:new');
    await sendMessage(peer, convId, 'hello-5');
    await got;
  });

  await report.check('password change revokes OTHER sessions and their sockets (current kept)', async () => {
    const a4 = await login(a.username, 'Passw0rd123');
    const s4 = await connectAndWait(a4);
    const d2 = waitFor(s2, 'disconnect', 5000);
    const res = await api<{ data?: { changed?: boolean; note?: string } }>(
      a4,
      'POST',
      '/api/auth/change-password',
      {
        currentPassword: 'Passw0rd123',
        newPassword: 'NewPass12345'
      }
    );
    assert.equal(res.status, 200);
    // Phase 3: the CURRENT session survives (it just proved the password) —
    // every OTHER session is revoked and disconnected. The response message
    // must describe exactly that.
    assert.equal(res.json.data?.note, 'Other sessions have been signed out.');
    await d2;
    assert.equal(s2.disconnected, true);
    assert.equal(s4.disconnected, false, 'current session socket must survive');
    const got = waitFor(s4, 'message:new');
    await sendMessage(peer, convId, 'hello-after-change');
    await got;
  });

  await report.check('logout disconnects that session socket', async () => {
    const a5 = await login(a.username, 'NewPass12345');
    const s5 = await connectAndWait(a5);
    const d5 = waitFor(s5, 'disconnect', 5000);
    const res = await api(a5, 'POST', '/api/auth/logout');
    assert.equal(res.status, 200);
    await d5;
    assert.equal(s5.disconnected, true);
  });

  await report.check('admin suspend disconnects the target user sockets', async () => {
    const admin = await login('admin', 'linkup123');
    const a6 = await login(a.username, 'NewPass12345');
    const s6 = await connectAndWait(a6);
    const d6 = waitFor(s6, 'disconnect', 5000);
    const res = await api(admin, 'PATCH', '/api/admin/users', {
      userId: a.id,
      action: 'SUSPEND'
    });
    assert.equal(res.status, 200);
    await d6;
    assert.equal(s6.disconnected, true);
    // Clean up: restore the account.
    await api(admin, 'PATCH', '/api/admin/users', { userId: a.id, action: 'ACTIVATE' });
    await sleep(100);
    sp.close();
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
