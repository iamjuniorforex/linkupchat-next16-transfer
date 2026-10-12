/**
 * Remediation — mailer was a dev stub (audit MEDIUM #3).
 *
 * Provider abstraction tests with a MOCKED transport (plus the real HTTP
 * transport against a local sink and the SMTP transport's error path).
 * Delivery is never faked: `delivered` reflects provider acceptance, and in
 * production nothing logs message bodies (reset links / codes).
 *
 * Real SMTP/transactional delivery needs provider credentials and is NOT
 * TESTABLE here — the transports are exercised against mocks/stubs instead.
 *
 * Run: npm run test:mailer
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  passwordResetEmail,
  sendMail,
  setMailTransportForTests,
  verificationEmail,
  type MailMessage,
  type MailTransport
} from '../src/lib/mailer';

let passed = 0;
let failed = 0;

// NODE_ENV is typed read-only (Next.js ProcessEnv) — mutate through a plain alias.
const env = process.env as Record<string, string | undefined>;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
}

function captureConsole() {
  const warns: string[] = [];
  const infos: string[] = [];
  const origWarn = console.warn;
  const origInfo = console.info;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
  console.info = (...args: unknown[]) => infos.push(args.map(String).join(' '));
  return {
    warns,
    infos,
    restore: () => {
      console.warn = origWarn;
      console.info = origInfo;
    }
  };
}

class CapturingTransport implements MailTransport {
  readonly name = 'mock';
  sent: MailMessage[] = [];
  failWith: Error | null = null;

  async send(message: MailMessage): Promise<{ messageId?: string }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { messageId: 'mock-id-1' };
  }
}

async function main() {
  console.log('■ mailer: provider abstraction, honest delivery, log hygiene');

  const SECRET = 'reset-password?token=SUPER-SECRET-TOKEN-123';

  await check('mocked transport: success reports delivered and passes content', async () => {
    const t = new CapturingTransport();
    setMailTransportForTests(t);
    const res = await sendMail({
      to: 'a@example.com',
      subject: 'Hello',
      text: `link: ${SECRET}`
    });
    setMailTransportForTests(null);
    assert.equal(res.delivered, true);
    assert.equal(res.provider, 'mock');
    assert.equal(res.messageId, 'mock-id-1');
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].to, 'a@example.com');
    assert.ok(t.sent[0].text.includes(SECRET));
  });

  await check('transport failure: delivered=false with reason, never fake success', async () => {
    const t = new CapturingTransport();
    t.failWith = new Error('provider exploded');
    setMailTransportForTests(t);
    const cap = captureConsole();
    const res = await sendMail({ to: 'a@example.com', subject: 'Hello', text: SECRET });
    setMailTransportForTests(null);
    cap.restore();
    assert.equal(res.delivered, false);
    assert.equal(res.provider, 'mock');
    assert.ok(res.reason?.includes('provider exploded'), `reason: ${res.reason}`);
    assert.equal(t.sent.length, 0);
  });

  await check('production without config: fails clearly and logs NO body', async () => {
    const prevNodeEnv = env.NODE_ENV;
    const prevTransport = process.env.MAIL_TRANSPORT;
    env.NODE_ENV = 'production';
    process.env.MAIL_TRANSPORT = 'none';
    setMailTransportForTests(null);
    const cap = captureConsole();
    const res = await sendMail({ to: 'a@example.com', subject: 'Reset', text: SECRET });
    cap.restore();
    env.NODE_ENV = prevNodeEnv;
    if (prevTransport === undefined) delete process.env.MAIL_TRANSPORT;
    else process.env.MAIL_TRANSPORT = prevTransport;
    assert.equal(res.delivered, false);
    assert.equal(res.reason, 'not-configured');
    const allLogs = [...cap.warns, ...cap.infos].join('\n');
    assert.ok(!allLogs.includes(SECRET), 'production log leaked the reset link');
    assert.ok(cap.warns.length > 0, 'no clear failure logged');
  });

  await check('development without config: preview logged, result stays undelivered', async () => {
    const prevNodeEnv = env.NODE_ENV;
    const prevTransport = process.env.MAIL_TRANSPORT;
    env.NODE_ENV = 'development';
    process.env.MAIL_TRANSPORT = 'none';
    setMailTransportForTests(null);
    const cap = captureConsole();
    const res = await sendMail({ to: 'a@example.com', subject: 'Reset', text: SECRET });
    cap.restore();
    env.NODE_ENV = prevNodeEnv;
    if (prevTransport === undefined) delete process.env.MAIL_TRANSPORT;
    else process.env.MAIL_TRANSPORT = prevTransport;
    assert.equal(res.delivered, false);
    assert.ok(res.reason?.includes('dev preview'), `reason: ${res.reason}`);
    assert.ok(cap.infos.join('\n').includes(SECRET), 'dev preview missing');
  });

  await check('empty recipient is refused (no silent success)', async () => {
    const t = new CapturingTransport();
    setMailTransportForTests(t);
    const res = await sendMail({ to: '', subject: 'x', text: 'y' });
    setMailTransportForTests(null);
    assert.equal(res.delivered, false);
    assert.equal(res.reason, 'no-recipient');
  });

  await check('http transactional transport delivers JSON to the provider', async () => {
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const prev = {
      MAIL_TRANSPORT: process.env.MAIL_TRANSPORT,
      MAIL_HTTP_URL: process.env.MAIL_HTTP_URL,
      MAIL_HTTP_TOKEN: process.env.MAIL_HTTP_TOKEN
    };
    process.env.MAIL_TRANSPORT = 'http';
    process.env.MAIL_HTTP_URL = `http://127.0.0.1:${port}/hook`;
    process.env.MAIL_HTTP_TOKEN = 'test-token';
    setMailTransportForTests(null);

    const res = await sendMail({ to: 'a@example.com', subject: 'Hi', text: 'body' });

    process.env.MAIL_TRANSPORT = prev.MAIL_TRANSPORT;
    if (prev.MAIL_HTTP_URL === undefined) delete process.env.MAIL_HTTP_URL;
    else process.env.MAIL_HTTP_URL = prev.MAIL_HTTP_URL;
    if (prev.MAIL_HTTP_TOKEN === undefined) delete process.env.MAIL_HTTP_TOKEN;
    else process.env.MAIL_HTTP_TOKEN = prev.MAIL_HTTP_TOKEN;
    server.close();

    assert.equal(res.delivered, true);
    assert.equal(res.provider, 'http');
    assert.equal(received.length, 1);
    assert.equal(received[0].headers.authorization, 'Bearer test-token');
    const payload = JSON.parse(received[0].body) as { to: string; subject: string };
    assert.equal(payload.to, 'a@example.com');
    assert.equal(payload.subject, 'Hi');
  });

  await check('http provider rejection: delivered=false', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const prev = { MAIL_TRANSPORT: process.env.MAIL_TRANSPORT, MAIL_HTTP_URL: process.env.MAIL_HTTP_URL };
    process.env.MAIL_TRANSPORT = 'http';
    process.env.MAIL_HTTP_URL = `http://127.0.0.1:${port}/hook`;
    setMailTransportForTests(null);

    const cap = captureConsole();
    const res = await sendMail({ to: 'a@example.com', subject: 'Hi', text: SECRET });
    cap.restore();

    process.env.MAIL_TRANSPORT = prev.MAIL_TRANSPORT;
    if (prev.MAIL_HTTP_URL === undefined) delete process.env.MAIL_HTTP_URL;
    else process.env.MAIL_HTTP_URL = prev.MAIL_HTTP_URL;
    server.close();

    assert.equal(res.delivered, false);
    assert.ok(!cap.warns.join('\n').includes(SECRET), 'failure log leaked the body');
  });

  await check('smtp transport error path reports undelivered (no crash)', async () => {
    const prev = {
      MAIL_TRANSPORT: process.env.MAIL_TRANSPORT,
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      NODE_ENV: env.NODE_ENV
    };
    process.env.MAIL_TRANSPORT = 'smtp';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1'; // nothing listens here
    env.NODE_ENV = 'production';
    setMailTransportForTests(null);

    const cap = captureConsole();
    const res = await sendMail({ to: 'a@example.com', subject: 'Hi', text: SECRET });
    cap.restore();

    process.env.MAIL_TRANSPORT = prev.MAIL_TRANSPORT;
    if (prev.SMTP_HOST === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = prev.SMTP_HOST;
    if (prev.SMTP_PORT === undefined) delete process.env.SMTP_PORT;
    else process.env.SMTP_PORT = prev.SMTP_PORT;
    if (prev.NODE_ENV === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = prev.NODE_ENV;

    assert.equal(res.delivered, false);
    assert.equal(res.provider, 'smtp');
    assert.ok(res.reason, 'no failure reason reported');
    assert.ok(!cap.warns.join('\n').includes(SECRET), 'smtp failure log leaked the body');
  });

  await check('message builders address the recipient and carry the token', async () => {
    const reset = passwordResetEmail('a@example.com', 'Ada', 'https://app/reset?token=abc');
    assert.equal(reset.to, 'a@example.com');
    assert.ok(reset.text.includes('https://app/reset?token=abc'));
    const verify = verificationEmail('a@example.com', 'Ada', '123456');
    assert.equal(verify.to, 'a@example.com');
    assert.ok(verify.text.includes('123456'));
  });

  console.log('\n════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
