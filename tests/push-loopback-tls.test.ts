/**
 * Regression: loopback fake-push TLS must succeed without disabling TLS
 * verification globally, and HTTP 410 must still be classified as gone.
 *
 * A different self-signed certificate on loopback must NOT be trusted.
 * A non-loopback endpoint must not receive the pinned agent.
 *
 * Run: npm run test:push-loopback-tls
 */
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PUSH_E2E_TEST_CERT, isLoopbackPushEndpoint, pushAgentForEndpoint } from '../src/lib/push-loopback-tls';

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

function listen(key: string, cert: string, status: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer({ key, cert }, (_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(status === 201 ? 'ok' : 'gone');
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function otherSelfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'push-other-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=not-the-test-pin'
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || process.env[m[1]] !== undefined) continue;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  } catch {
    // optional — the test generates VAPID keys when they are absent
  }
}

function subscriptionKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

async function main() {
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined, 'this test must not disable TLS verification');
  loadEnvFile();

  assert.equal(isLoopbackPushEndpoint('https://127.0.0.1:9/push/a'), true);
  assert.equal(isLoopbackPushEndpoint('https://localhost/push/a'), true);
  assert.equal(isLoopbackPushEndpoint('https://[::1]/push/a'), true);
  assert.equal(isLoopbackPushEndpoint('https://fcm.googleapis.com/fcm/send/x'), false);
  assert.equal(isLoopbackPushEndpoint('https://127.0.0.1.evil.test/push/a'), false);
  assert.equal(isLoopbackPushEndpoint('http://127.0.0.1/push/a'), false);
  assert.ok(pushAgentForEndpoint('https://127.0.0.1:9/push/a'));
  assert.equal(pushAgentForEndpoint('https://fcm.googleapis.com/fcm/send/x'), undefined);
  console.log('  ✓ pinned agent is loopback-only');

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    const webpushMod = await import('web-push');
    const webpush = (webpushMod as unknown as { default?: typeof webpushMod; generateVAPIDKeys?: () => { publicKey: string; privateKey: string } }).default ?? webpushMod;
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:push-test@localhost';
  }

  const { sendWebPush } = await import('../src/lib/push');
  const keys = subscriptionKeys();

  const ok = await listen(TEST_TLS_KEY, PUSH_E2E_TEST_CERT, 201);
  try {
    const sent = await sendWebPush(
      { endpoint: `https://127.0.0.1:${ok.port}/push/ok`, keys },
      { title: 'tls' }
    );
    assert.equal(sent.sent, true, `pinned loopback cert must deliver without NODE_TLS_REJECT_UNAUTHORIZED (${sent.reason ?? ''})`);
    console.log('  ✓ pinned loopback certificate is accepted');
  } finally {
    await ok.close();
  }

  const gone = await listen(TEST_TLS_KEY, PUSH_E2E_TEST_CERT, 410);
  try {
    const result = await sendWebPush(
      { endpoint: `https://127.0.0.1:${gone.port}/push/gone`, keys },
      { title: 'gone' }
    );
    assert.equal(result.sent, false);
    assert.equal(result.gone, true, `410 must be classified gone, got ${result.reason ?? 'no reason'}`);
    console.log('  ✓ HTTP 410 on the pinned endpoint is gone');
  } finally {
    await gone.close();
  }

  const other = otherSelfSigned();
  const bad = await listen(other.key, other.cert, 201);
  try {
    const result = await sendWebPush(
      { endpoint: `https://127.0.0.1:${bad.port}/push/bad`, keys },
      { title: 'bad' }
    );
    assert.equal(result.sent, false, 'a different self-signed loopback cert must not be trusted');
    assert.notEqual(result.gone, true);
    console.log('  ✓ unpinned self-signed loopback certificate is rejected');
  } finally {
    await bad.close();
  }

  console.log('\nPASSED 4  FAILED 0');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
