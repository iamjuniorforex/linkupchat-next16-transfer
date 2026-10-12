/**
 * Phase 3 — Web Push end-to-end (real `web-push` delivery to a fake push
 * service over real HTTP).
 *
 * The app server (running with VAPID test keys) encrypts and POSTs actual
 * web-push requests to subscription endpoints pointing at a local fake push
 * service owned by this test process. That exercises the REAL provider
 * invocation path (RFC 8291 encryption + HTTP delivery), not a mock.
 *
 * Covers: subscription create/upsert/remove; ownership enforcement;
 * duplicate endpoint dedupe; invalid payload rejection; multi-device fan-out;
 * permanently-invalid (410) endpoint cleanup; blocked users never push;
 * notification-preference gating; active-viewer suppression; unsubscribe.
 *
 * Run: npm run test:push:e2e   (SERVER_URL=http://localhost:3300;
 *      the server must run with VAPID_* configured).
 * The fake push service uses the pinned self-signed cert in
 * src/lib/push-loopback-tls.ts. The server trusts that cert for loopback
 * endpoints only — do not set NODE_TLS_REJECT_UNAUTHORIZED.
 */
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { api, connectSocket, createReporter, login, sleep, type Session } from './helpers';
import { PUSH_E2E_TEST_CERT } from '../src/lib/push-loopback-tls';

const report = createReporter();
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';

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

// ── Fake push service (HTTPS: the `web-push` library is TLS-only, like every
// real push service). Self-signed TEST certificate — the public cert is the
// pin in src/lib/push-loopback-tls.ts. The private key is test-only.
const TEST_TLS_CERT = PUSH_E2E_TEST_CERT;
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC9FgYLT+OkbfvJ
KMCgbW+515zTj8NwhIuTXpt4O3bbmDJlRkBPBNVbG8gOodZqeokjqENg8F9tI3s8
TZ0JN1LY57haKJiyynXN8Aq9k2KlTwj1qQTAo9OkZJaKiMKOvPM64WzfTM8zve05
40zL8GQfRL4OBZiRl/IrD9ZorBMBEksL0gzEWWt7MdXbanA7hJ81Af2iEp+0jZn0
AbXw8vZngKH0R2f8+R2HHKJVQyCewivtgA+rwVibFWkjvK666u7Lx1GuZFi2/Ohf
smbDp1eeKOnHMciZ7Bd/jSY1QvlCwa79MKR8zF83yN1Kv1R7cAseHl+WDOQwGwSl
aoLr3ek5AgMBAAECggEAKXUHtDk63xViLBOsUEBOS7/TWatenW/iLliC29Sl1bXD
7uJ9PRYBNW2c6mBfY48kPFYrF7j8IzCxV2Jo+NlRZ88+Yz4dZK3xMErd//ytlzMB
8uKw8Q+6WoPXYd5kUelpptJADaGImH6e4Z9NejVlrlljFi3x6pIW/YwGZYK80/Hu
4lnf+kboii7It//JhXZnjKJRKV1sL5Sc7Q1kKgJ7ejPi6o4OUuHf/TcF2bPqeZ/V
AgK8EtLXlRAFA2meb0VPqMNSwcq0HIHFK222Sm4ANccqM+GoEPNDar0SxJcdJqK+
erQR7k1YDEdmq3wKZbAGgmtroSGsxGltiytAb51adQKBgQDyxOrQYkpES1xFUrO0
FdGWiMKWuVv+r3BjbL6fTqcbSn1ZtiY3JzxWfWTEA+kNwR907eZSno3u94nPg2VA
nNW6u+bcXiTMobrpZtbRo3V+4odtq4fYau1SFWlVwPDYFXJV8qEVwHIZck88vBKj
Bxlie7ZZhlIO5nsAO6BMJxaTbwKBgQDHZCBCa4WG1wz5eZQysPy4n9B7fgmtj/6T
+t2DyUjIaXkiQDbySJgveXqGvRKFXERnHRvQBAt6vnj7G8c6pg9g9RTmUbNxX3bP
CwzU0N9B587hcgVoPFVnipeXoH02r36Ka2rTxEISbph8UkPmmtTme+y8NCiL9HFS
a2ER9oHZ1wKBgE/l8SYOA0VAzChglJYjTCxP7ELw1E8Y7FM8mewSVbsMo/6fjSo/
toL8l+pPIyeMtM6l8VSlrC7Gt0tdgjhmpYzkhJFoRpI2dC6W0wKB2oyc/1dfycC3
SE3okBdR/bIQNOYGiW+AO80WKu/hMf0HvBoGfzgtldojjr2/4fzOLIbvAoGAF/DY
wsDgRoF5yFalybRgk9Z0lO9cQB/DBIeho1o+x/mKFue48TxwMXsXkCgRmjuq5uqi
1UY3DqTiJ9x8/njD7fNfcAwtTJaW0GNWRhNSSzqHJ6CmL47W/liwvP8DKdbGjd45
9HVjLY1j98F077J1j7sfgLWOjMdr9+Z2wE5l5v8CgYBuGN5iAWQUxDU2ys2KzQaE
NduwLsT41S6Jfto2r8N+WPijZtxMuUGO89oOYPDeYya2/ZGurykiQ8BKvlnzoIyb
FUO0HxLJ9lAYI/0Hzl6rfd6q4DthnOUzldz6lp3PGP8Cd9zdTNPY0K0/rNIJDT8m
85nYzBgzVKJS+tZldQFwWQ==
-----END PRIVATE KEY-----`;

type Post = { path: string; headers: http.IncomingHttpHeaders; bodyLength: number };

const posts: Post[] = [];
const gonePaths = new Set<string>();

function startFakePushService(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = https.createServer(
      { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const url = req.url ?? '/';
          posts.push({ path: url, headers: req.headers, bodyLength: Buffer.concat(chunks).length });
          if (gonePaths.has(url)) {
            res.writeHead(410, { 'content-type': 'text/plain' });
            res.end('gone');
            return;
          }
          res.writeHead(201, { 'content-type': 'text/plain' });
          res.end('ok');
        });
      }
    );
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

async function waitForPostCount(min: number, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (posts.length >= min) return true;
    await sleep(100);
  }
  return posts.length >= min;
}

/** A structurally valid Web Push subscription keypair (P-256 ECDH). */
function makeSubscriptionKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url')
  };
}

async function register(username: string): Promise<Session> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${SERVER_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: `Push ${username}`,
        username,
        password: 'linkup123',
        email: `${username}@ex.test`
      })
    });
    if (res.status !== 429) break;
    await sleep(15_000);
  }
  if (!res || !res.ok) throw new Error(`register failed for ${username}: HTTP ${res?.status}`);
  return login(username, 'linkup123');
}

async function main() {
  loadDbEnv();
  const { port, close } = await startFakePushService();
  const stamp = Date.now().toString(36);

  const subUrl = (id: string) => `https://127.0.0.1:${port}/push/${id}`;
  const device1 = `d1_${stamp}`;
  const device2 = `d2_${stamp}`;

  const p1 = await register(`pxa${stamp}`.slice(0, 24));
  const p2 = await register(`pxb${stamp}`.slice(0, 24));

  const subscribe = (s: Session, id: string) =>
    api(s, 'POST', '/api/push/subscribe', {
      endpoint: subUrl(id),
      keys: makeSubscriptionKeys(),
      userAgent: 'push-e2e'
    });

  try {
    await report.check('server reports push capability with its public VAPID key', async () => {
      const res = await api<{ data?: { configured: boolean; publicKey: string | null; subscriptions: unknown[] } }>(
        p1,
        'GET',
        '/api/push/subscribe'
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.data?.configured, true, 'test server must run with VAPID keys');
      assert.ok(res.json.data?.publicKey);
      assert.deepEqual(res.json.data?.subscriptions, []);
    });

    await report.check('subscription create + same-endpoint upsert keeps one row (dedupe)', async () => {
      const first = await subscribe(p1, device1);
      assert.equal(first.status, 201);
      const again = await subscribe(p1, device1);
      assert.equal(again.status, 200);
      const list = await api<{ data?: { subscriptions: { endpoint: string }[] } }>(
        p1,
        'GET',
        '/api/push/subscribe'
      );
      assert.equal(list.json.data?.subscriptions.length, 1);
      assert.equal(list.json.data?.subscriptions[0]?.endpoint, subUrl(device1));
    });

    await report.check('invalid payloads are rejected with 422', async () => {
      const badEndpoint = await api(p1, 'POST', '/api/push/subscribe', {
        endpoint: 'not-a-url',
        keys: makeSubscriptionKeys()
      });
      assert.equal(badEndpoint.status, 422);
      const badScheme = await api(p1, 'POST', '/api/push/subscribe', {
        endpoint: 'ftp://push.example.test/x',
        keys: makeSubscriptionKeys()
      });
      assert.equal(badScheme.status, 422);
      const httpScheme = await api(p1, 'POST', '/api/push/subscribe', {
        endpoint: 'http://push.example.test/x',
        keys: makeSubscriptionKeys()
      });
      assert.equal(httpScheme.status, 422, 'plain-http endpoints are rejected (Web Push requires https)');
      const missingKeys = await api(p1, 'POST', '/api/push/subscribe', {
        endpoint: subUrl(`bad_${stamp}`)
      });
      assert.equal(missingKeys.status, 422);
      const badKeyChars = await api(p1, 'POST', '/api/push/subscribe', {
        endpoint: subUrl(`bad2_${stamp}`),
        keys: { p256dh: '!!!not base64url!!!', auth: '???also bad???' }
      });
      assert.equal(badKeyChars.status, 422);
    });

    await report.check('subscriptions are owned: other users can never touch them', async () => {
      const steal = await api<{ error?: { code: string } }>(p2, 'POST', '/api/push/subscribe', {
        endpoint: subUrl(device1),
        keys: makeSubscriptionKeys()
      });
      assert.equal(steal.status, 409);
      const remove = await api(p2, 'DELETE', '/api/push/subscribe', {
        endpoint: subUrl(device1)
      });
      assert.equal(remove.status, 404);
      const list = await api<{ data?: { subscriptions: unknown[] } }>(p1, 'GET', '/api/push/subscribe');
      assert.equal(list.json.data?.subscriptions.length, 1);
    });

    await report.check('a message delivers a real web-push to every device of the recipient', async () => {
      await subscribe(p1, device2); // second device
      const conv = await api<{ data?: { conversation?: { id: string } } }>(p2, 'POST', '/api/conversations', {
        type: 'DIRECT',
        username: p1.username
      });
      const convId = conv.json.data?.conversation?.id ?? (conv.json.data as { id?: string })?.id;
      assert.ok(convId);
      (globalThis as Record<string, unknown>).__pushConvId = convId;

      const sent = await api(p2, 'POST', `/api/conversations/${convId}/messages`, {
        type: 'TEXT',
        content: 'push me'
      });
      assert.equal(sent.status, 201);

      const got = await waitForPostCount(2);
      assert.ok(got, `expected 2 push deliveries, got ${posts.length}`);
      const paths = posts.map((p) => p.path).sort();
      assert.deepEqual(paths, [`/push/${device1}`, `/push/${device2}`]);
      // Real web-push POST: encrypted body + RFC 8291/8292 headers present.
      const sample = posts[0]!;
      assert.ok(sample.bodyLength > 0, 'encrypted payload body sent');
      assert.ok(sample.headers['content-encoding'], 'payload is encrypted (content-encoding)');
      assert.ok(sample.headers['authorization'], 'VAPID Authorization header present');
      assert.ok(sample.headers.ttl !== undefined);
    });

    await report.check('permanently invalid endpoints (410) are unsubscribed automatically', async () => {
      posts.length = 0;
      gonePaths.add(`/push/${device2}`);
      const convId = (globalThis as Record<string, unknown>).__pushConvId as string;
      const sent = await api(p2, 'POST', `/api/conversations/${convId}/messages`, {
        type: 'TEXT',
        content: 'one device dies'
      });
      assert.equal(sent.status, 201);
      const got = await waitForPostCount(1);
      assert.ok(got, 'the healthy device still receives');
      await sleep(800); // allow the cleanup write to land
      const list = await api<{ data?: { subscriptions: { endpoint: string }[] } }>(
        p1,
        'GET',
        '/api/push/subscribe'
      );
      const endpoints = (list.json.data?.subscriptions ?? []).map((s) => s.endpoint);
      assert.ok(endpoints.includes(subUrl(device1)), 'healthy subscription kept');
      assert.ok(!endpoints.includes(subUrl(device2)), 'gone subscription removed');
    });

    await report.check('notification preferences gate push (notifMessages=off)', async () => {
      posts.length = 0;
      await api(p1, 'PATCH', '/api/users/me/settings', { notifMessages: false });
      const convId = (globalThis as Record<string, unknown>).__pushConvId as string;
      await api(p2, 'POST', `/api/conversations/${convId}/messages`, {
        type: 'TEXT',
        content: 'should not push'
      });
      await sleep(1500);
      assert.equal(posts.length, 0, 'disabled preference must not push');
      await api(p1, 'PATCH', '/api/users/me/settings', { notifMessages: true });
    });

    await report.check('an actively viewing recipient is not pushed (open-chat suppression)', async () => {
      posts.length = 0;
      const convId = (globalThis as Record<string, unknown>).__pushConvId as string;
      const socket = connectSocket(p1);
      await sleep(400);
      socket.emit('conversation:viewing', { conversationId: convId });
      await sleep(300);
      await api(p2, 'POST', `/api/conversations/${convId}/messages`, {
        type: 'TEXT',
        content: 'you are looking at this'
      });
      await sleep(1500);
      assert.equal(posts.length, 0, 'actively viewing users are never pushed');
      socket.emit('conversation:idle', {});
      socket.close();
    });

    await report.check('blocked senders never trigger push', async () => {
      posts.length = 0;
      const convId = (globalThis as Record<string, unknown>).__pushConvId as string;
      const block = await api(p1, 'POST', `/api/users/${p2.username}/block`, { blocked: true });
      assert.equal(block.status, 200);
      const sent = await api(p2, 'POST', `/api/conversations/${convId}/messages`, {
        type: 'TEXT',
        content: 'blocked message'
      });
      assert.equal(sent.status, 403);
      await sleep(1500);
      assert.equal(posts.length, 0, 'blocked users must not reach the push service');
      await api(p1, 'POST', `/api/users/${p2.username}/block`, { blocked: false });
    });

    await report.check('unsubscribe removes the subscription (idempotent-safe 404 afterwards)', async () => {
      const del = await api(p1, 'DELETE', '/api/push/subscribe', { endpoint: subUrl(device1) });
      assert.equal(del.status, 200);
      const again = await api(p1, 'DELETE', '/api/push/subscribe', { endpoint: subUrl(device1) });
      assert.equal(again.status, 404);
      const list = await api<{ data?: { subscriptions: unknown[] } }>(p1, 'GET', '/api/push/subscribe');
      assert.equal(list.json.data?.subscriptions.length, 0);
    });

    report.finish();
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
