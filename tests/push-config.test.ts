/**
 * Phase 3 fix — VAPID configuration recognition tests (no DB / no server).
 *
 * Production incident: credential values present but malformed (wrapping
 * quotes, trailing newlines from copy/paste, base64 `=` padding, standard
 * base64 `+/` chars) made web-push's validators THROW; the app swallowed
 * that into "not configured". These tests pin:
 *  - valid VAPID configuration IS recognized (incl. the production https:
 *    subject format);
 *  - invalid/missing configuration stays DISABLED (fail-safe preserved)
 *    with precise, secret-free reasons;
 *  - the common paste-corruption class is normalized and accepted;
 *  - the PUBLIC VAPID key is exposed correctly — and the PRIVATE key never
 *    reaches any output.
 *
 * Run: npm run test:push-config
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReporter } from './helpers';

const report = createReporter();
const env = process.env as Record<string, string | undefined>;

function setVapid(opts: { subject?: string; pub?: string; priv?: string }) {
  if ('subject' in opts) env.VAPID_SUBJECT = opts.subject;
  if ('pub' in opts) env.VAPID_PUBLIC_KEY = opts.pub;
  if ('priv' in opts) env.VAPID_PRIVATE_KEY = opts.priv;
}

function clearVapid() {
  delete env.VAPID_SUBJECT;
  delete env.VAPID_PUBLIC_KEY;
  delete env.VAPID_PRIVATE_KEY;
  delete env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
}

async function main() {
  const push = await import('../src/lib/push');
  const webpushMod = await import('web-push');
  const webpush = (webpushMod as unknown as { default?: typeof webpushMod }).default ?? webpushMod;

  const keys = webpush.generateVAPIDKeys();
  const PROD_SUBJECT = 'https://linkupchat-production-969c.up.railway.app';

  await report.check('valid VAPID configuration is recognized (https: production subject)', async () => {
    clearVapid();
    setVapid({ subject: PROD_SUBJECT, pub: keys.publicKey, priv: keys.privateKey });
    const status = push.diagnoseVapid();
    assert.equal(status.ok, true);
    assert.equal(push.isPushConfigured(), true);
  });

  await report.check('valid VAPID configuration is recognized (mailto: subject)', async () => {
    setVapid({ subject: 'mailto:admin@example.com' });
    assert.equal(push.isPushConfigured(), true);
    setVapid({ subject: PROD_SUBJECT });
  });

  await report.check('missing VAPID configuration stays disabled (fail-safe, never claims sent)', async () => {
    clearVapid();
    const status = push.diagnoseVapid();
    assert.equal(status.ok, false);
    if (!status.ok) assert.equal(status.reason, 'missing');
    assert.equal(push.isPushConfigured(), false);
    const res = await push.sendWebPush(
      { endpoint: 'https://push.example.test/x', keys: { p256dh: 'p', auth: 'a' } },
      { title: 't' }
    );
    assert.equal(res.sent, false);
    assert.match(res.reason ?? '', /VAPID/i);
  });

  await report.check('production paste corruption is normalized and accepted (the incident class)', async () => {
    // Wrapping quotes + trailing newlines + base64 padding + standard-base64
    // characters — all losslessly recoverable, all previously fatal.
    const quoted = `"${keys.publicKey}"`;
    const newline = `${keys.privateKey}\n`;
    const padded = `${keys.publicKey}=`;
    const std = keys.publicKey.replace(/-/g, '+').replace(/_/g, '/');
    clearVapid();
    setVapid({ subject: `"${PROD_SUBJECT}"`, pub: quoted, priv: newline });
    assert.equal(push.isPushConfigured(), true, 'quotes/newlines are stripped');
    setVapid({ pub: padded, priv: newline });
    assert.equal(push.isPushConfigured(), true, 'base64 padding is stripped');
    setVapid({ pub: std, priv: newline });
    assert.equal(push.isPushConfigured(), true, 'standard base64 maps to base64url');
  });

  await report.check('truly invalid credentials stay disabled with precise reasons', async () => {
    clearVapid();
    setVapid({ subject: 'linkupchat-production-969c.up.railway.app', pub: keys.publicKey, priv: keys.privateKey });
    let status = push.diagnoseVapid();
    assert.equal(status.ok, false);
    if (!status.ok) assert.equal(status.reason, 'invalid-subject', 'bare host (no scheme) rejected');

    setVapid({ subject: PROD_SUBJECT, pub: keys.publicKey.slice(0, 80), priv: keys.privateKey });
    status = push.diagnoseVapid();
    assert.equal(status.ok, false);
    if (!status.ok) assert.equal(status.reason, 'invalid-public-key', 'truncated public key rejected');

    setVapid({ pub: keys.publicKey, priv: keys.privateKey.slice(0, 30) });
    status = push.diagnoseVapid();
    assert.equal(status.ok, false);
    if (!status.ok) assert.equal(status.reason, 'invalid-private-key', 'truncated private key rejected');

    setVapid({ pub: keys.privateKey, priv: keys.publicKey });
    assert.equal(push.isPushConfigured(), false, 'swapped key roles rejected');
    assert.equal(push.isPushConfigured(), false);
  });

  await report.check('public VAPID key is exposed correctly (normalized, public only)', async () => {
    clearVapid();
    setVapid({ subject: PROD_SUBJECT, pub: `"${keys.publicKey}"`, priv: keys.privateKey });
    env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = `${keys.publicKey}\n`;
    const exposed = push.getPublicVapidKey();
    assert.equal(exposed, keys.publicKey, 'NEXT_PUBLIC variant wins and is normalized');
    delete env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    assert.equal(push.getPublicVapidKey(), keys.publicKey, 'falls back to VAPID_PUBLIC_KEY');
  });

  await report.check('the private key never reaches any client-facing output', async () => {
    const outputs = JSON.stringify({
      status: push.diagnoseVapid(),
      isPushConfigured: push.isPushConfigured(),
      publicKey: push.getPublicVapidKey()
    });
    assert.ok(!outputs.includes(keys.privateKey), 'private key must not appear in any output');
    assert.ok(outputs.includes(keys.publicKey), 'public key exposure is expected');
  });

  await report.check('client bundle never contains VAPID_PRIVATE_KEY material', async () => {
    const staticDir = path.resolve(process.cwd(), '.next/static');
    if (!fs.existsSync(staticDir)) {
      console.log('    (no .next/static build present — skipped)');
      return;
    }
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|css|json)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('VAPID_PRIVATE_KEY')) offenders.push(full);
          if (env.VAPID_PRIVATE_KEY && text.includes(env.VAPID_PRIVATE_KEY)) offenders.push(full);
        }
      }
    };
    walk(staticDir);
    assert.deepEqual(offenders, [], 'no client chunk may reference the VAPID private key');
  });

  // Restore a working configuration for any subsequent suites in this process.
  clearVapid();
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
