/**
 * Phase 3 fix — production VAPID recognition e2e (spawns its OWN servers).
 *
 * Reproduces and verifies the production incident end-to-end on the REAL
 * production startup path (`tsx server.ts`, NODE_ENV=production):
 *   1. clean VAPID values + the production https: subject → push reports
 *      configured:true and exposes exactly the public key;
 *   2. the incident's paste corruption (wrapping quotes / trailing newlines /
 *      base64 padding) → NOW RECOGNIZED (normalized) and configured:true;
 *   3. truly malformed credentials → configured:false with a precise, safe
 *      `configuredReason` (previously a misleading "not configured");
 *   4. a REAL browser session subscribes via the Settings UI and a REAL
 *      web-push is delivered to that subscription (Google's push service
 *      accepts it — statusCode 201);
 *   5. the client bundle never contains the private key.
 *
 * Run: npm run test:push-config
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createReporter } from './helpers';
import puppeteer, { type Browser } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';

const report = createReporter();
const BASE_PORT = 3397;
const PROD_SUBJECT = 'https://linkupchat-production-969c.up.railway.app';

const env = process.env as Record<string, string | undefined>;

/** Load DATABASE_URL (and friends) from the project's .env when the parent
 *  process did not explicitly provide them. Same convention as
 *  tests/auth-security.e2e.ts / account-deletion / email-verify /
 *  notification-retention. Explicit env vars always win. */
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

type VapidEnv = { subject: string; pub: string; priv: string; nextPub?: string; corrupt?: boolean };

async function startServer(port: number, vapid: VapidEnv | null): Promise<{ base: string; stop: () => Promise<void> }> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'push-config e2e: DATABASE_URL is not set and no .env value was found — set it explicitly or add it to .env.'
    );
  }
  const quote = (s: string) => (vapid && vapid.corrupt ? `"${s}"\n` : s);
  const child: ChildProcess = spawn(
    path.resolve('node_modules/.bin/tsx'),
    ['server.ts'],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: env.SESSION_SECRET ?? 'phase1-secret',
        APP_URL: `http://localhost:${port}`,
        NODE_ENV: 'production',
        PORT: String(port),
        HOST: '127.0.0.1',
        ...(vapid
          ? {
              VAPID_SUBJECT: vapid.subject,
              VAPID_PUBLIC_KEY: quote(vapid.pub),
              VAPID_PRIVATE_KEY: quote(vapid.priv),
              NEXT_PUBLIC_VAPID_PUBLIC_KEY: quote(vapid.nextPub ?? vapid.pub)
            }
          : {
              // Explicitly empty so the scenario is deterministic even when the
              // test runner's own environment carries VAPID values.
              VAPID_SUBJECT: '',
              VAPID_PUBLIC_KEY: '',
              VAPID_PRIVATE_KEY: '',
              NEXT_PUBLIC_VAPID_PUBLIC_KEY: ''
            })
      }
    }
  );
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) break;
        /* Any HTTP response (e.g. 503) proves the application process is bound
         * and serving — the tsx wrapper exiting is not the app dying. Keep polling. */
      } catch {
        /* Unreachable (connection refused / request timed out): nothing is
         * listening — fatal only if the tsx wrapper has also exited. */
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
      }
      if (Date.now() > deadline) throw new Error('server did not become healthy in 30s');
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (err) {
    /* Genuine startup failure: reap the detached process group so no orphaned
     * server survives to hold the port for the next scenario or run. */
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
    throw err;
  }
  return {
    base,
    stop: async () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      await new Promise((r) => setTimeout(r, 800));
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
}

async function apiSession(base: string) {
  const suffix = `${Date.now() % 100000}${Math.floor(Math.random() * 10000)}`;
  const username = `vcfg${suffix}`;
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Vapid Config User',
      username,
      password: 'linkup123',
      email: `${username}@ex.test`
    })
  });
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password: 'linkup123' })
  });
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const m = /linkup_session=([^;]+)/.exec(setCookie);
  assert.ok(m, 'no session cookie from login');
  return { cookie: `linkup_session=${m![1]}`, username };
}

async function getPushState(base: string, cookie: string) {
  const res = await fetch(`${base}/api/push/subscribe`, { headers: { cookie } });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

function checkNoClientLeak(privateKey: string, label: string) {
  const staticDir = path.resolve(process.cwd(), '.next/static');
  if (!fs.existsSync(staticDir)) {
    console.log(`    (${label}: no .next/static — skipped)`);
    return;
  }
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|css|json)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes('VAPID_PRIVATE_KEY') || (privateKey && text.includes(privateKey))) offenders.push(full);
      }
    }
  };
  walk(staticDir);
  assert.deepEqual(offenders, [], `${label}: client chunks must never contain private key material`);
}

async function main() {
  loadDbEnv();
  // Next freezes NEXT_PUBLIC_* into compiled output at build time — even into
  // server route chunks. A build made with NEXT_PUBLIC_VAPID_PUBLIC_KEY set
  // (e.g. from .env) serves that stale key and shadows the per-scenario fresh
  // credentials. Build once with it blanked so runtime keys are the served ones.
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, NEXT_PUBLIC_VAPID_PUBLIC_KEY: '' }
  });
  if (build.status !== 0) {
    throw new Error('push-config e2e: `npm run build` failed — the suite needs a fresh .next built without NEXT_PUBLIC_VAPID_PUBLIC_KEY.');
  }
  const webpushMod = await import('web-push');
  const webpush = (webpushMod as unknown as { default?: typeof webpushMod }).default ?? webpushMod;
  const keys = webpush.generateVAPIDKeys();

  // ── Scenario 1: clean values + production https: subject (server + browser) ──
  let server = await startServer(BASE_PORT, {
    subject: PROD_SUBJECT,
    pub: keys.publicKey,
    priv: keys.privateKey
  });

  await report.check('production startup with valid VAPID reports configured:true', async () => {
    const { cookie } = await apiSession(server.base);
    const { status, body, text } = await getPushState(server.base, cookie);
    assert.equal(status, 200);
    assert.equal(body.data.configured, true, `expected configured:true, got reason=${body.data.configuredReason}`);
    assert.equal(body.data.configuredReason, 'ok');
    assert.equal(body.data.publicKey, keys.publicKey, 'public key exposed exactly');
    assert.ok(!text.includes(keys.privateKey), 'private key must not appear in the API response');
  });

  await report.check('a real browser can subscribe via the Settings UI', async () => {
    const { cookie } = await apiSession(server.base);
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({
        executablePath: requireChromiumExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });
      const ctx = browser.defaultBrowserContext();
      await ctx.overridePermissions(server.base, ['notifications']);
      const page = await browser.newPage();
      const [name, value] = cookie.split('=');
      await page.setCookie({ name, value, domain: 'localhost', path: '/' });
      await page.goto(`${server.base}/app/settings`, { waitUntil: 'networkidle2', timeout: 45_000 });
      // Open the Notifications tab (stable test id from the settings page).
      await page.waitForSelector('[data-testid="settings-tab-notifications"]', { timeout: 15_000 });
      await page.click('[data-testid="settings-tab-notifications"]');
      await page.waitForFunction(
        () => document.body.innerText.includes('Browser push'),
        { timeout: 15_000 }
      );
      const unavailableCopy = await page.evaluate(() =>
        document.body.innerText.includes('not available on this server yet')
      );
      assert.equal(unavailableCopy, false, 'push card must NOT report "not available" with valid credentials');
      const enableBtn = await page.$('[data-testid="enable-push-notifications"]');
      assert.ok(enableBtn, 'Enable control must be present with valid credentials');
      await enableBtn!.click();
      // Real PushManager.subscribe + POST /api/push/subscribe round-trip —
      // the card flips to "Enabled on this device" once the server accepted
      // it. The push service can transiently reject a subscribe; a real user
      // would simply press Enable again.
      const waitForEnabled = () =>
        page.waitForFunction(() => document.body.innerText.includes('Enabled on this device'), {
          timeout: 20_000
        });
      try {
        await waitForEnabled();
      } catch {
        const retryBtn = await page.$('[data-testid="enable-push-notifications"]');
        assert.ok(retryBtn, 'Enable control must still be available for a retry');
        await retryBtn!.click();
        await waitForEnabled();
      }
      const perm = await page.evaluate(() => Notification.permission);
      assert.equal(perm, 'granted');
      const subJson = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        const sub = reg.pushManager ? await reg.pushManager.getSubscription() : null;
        return sub ? sub.toJSON() : null;
      });
      assert.ok(subJson?.endpoint?.startsWith('https://'), 'real browser subscription must have an https endpoint');
      assert.ok(subJson?.keys?.p256dh && subJson?.keys?.auth, 'subscription must carry encryption keys');
      // Server side: the subscription is stored for this user.
      const { body } = await getPushState(server.base, cookie);
      assert.equal(body.data.subscriptions.length, 1);
      assert.ok(body.data.subscriptions[0].endpoint.startsWith('https://'));
      // REAL delivery to the REAL browser subscription. A brand-new FCM
      // endpoint can reject the first delivery for a moment (propagation),
      // so retry transient push-service errors with backoff — the delivery
      // itself is always real.
      let lastError = '';
      let delivered = false;
      for (let attempt = 1; attempt <= 4 && !delivered; attempt++) {
        try {
          const sendRes = await webpush.sendNotification(
            { endpoint: subJson!.endpoint!, keys: { p256dh: subJson!.keys!.p256dh!, auth: subJson!.keys!.auth! } },
            JSON.stringify({ type: 'message.new', title: 'Linkup Push Config E2E', body: 'real delivery' }),
            { vapidDetails: { subject: PROD_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey } }
          );
          assert.equal(sendRes.statusCode, 201, `push service must accept real delivery, got ${sendRes.statusCode}`);
          delivered = true;
        } catch (err) {
          const e = err as { message?: string; statusCode?: number; body?: string };
          lastError = `attempt ${attempt}: ${e.message} status=${e.statusCode} body=${String(e.body).slice(0, 200)}`;
          await new Promise((r) => setTimeout(r, 1_500 * attempt));
        }
      }
      assert.ok(delivered, `real web-push delivery failed — ${lastError}`);
    } finally {
      await browser?.close();
    }
  });

  await report.check('client bundle never contains the VAPID private key', async () => {
    checkNoClientLeak(keys.privateKey, 'clean-scenario');
  });

  await report.check('a response without subscriptions cannot crash a subscribed client', async () => {
    // Regression: `server?.subscriptions.length` threw when a subscribed
    // browser met a response missing `subscriptions` — with no error boundary
    // that unmounted the ENTIRE app shell (the "UI disappears" class).
    const { cookie } = await apiSession(server.base);
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({
        executablePath: requireChromiumExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });
      const ctx = browser.defaultBrowserContext();
      await ctx.overridePermissions(server.base, ['notifications']);
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
      // GET /api/push/subscribe answers with the real public key but WITHOUT
      // the `subscriptions` field (older/mismatched API shape).
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().endsWith('/api/push/subscribe') && req.method() === 'GET') {
          void req.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': server.base },
            body: JSON.stringify({
              ok: true,
              data: { configured: true, configuredReason: 'ok', publicKey: keys.publicKey }
            })
          });
        } else {
          void req.continue();
        }
      });
      const [name, value] = cookie.split('=');
      await page.setCookie({ name, value, domain: 'localhost', path: '/' });
      await page.goto(`${server.base}/app/settings`, { waitUntil: 'networkidle2', timeout: 45_000 });
      await page.waitForSelector('[data-testid="settings-tab-notifications"]', { timeout: 15_000 });
      await page.click('[data-testid="settings-tab-notifications"]');
      const enableBtn = await page.waitForSelector('[data-testid="enable-push-notifications"]', {
        timeout: 15_000
      });
      assert.ok(enableBtn, 'Enable control must be present before subscribing');
      await enableBtn!.click();
      await page.waitForFunction(() => document.body.innerText.includes('Enabled on this device'), {
        timeout: 30_000
      });
      // The card (and the whole settings shell) must still be alive.
      await new Promise((r) => setTimeout(r, 1_500));
      assert.ok(
        await page.$('[data-testid="push-notifications-card"]'),
        'push card must stay mounted when subscriptions is missing'
      );
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(text.includes('Enabled on this device'), 'subscribed state must still render');
      assert.deepEqual(pageErrors, [], 'no client exception may fire');
    } finally {
      await browser?.close();
    }
  });

  await server.stop();

  // ── Scenario 2: the production incident's paste corruption — now recovered ──
  await report.check('paste-corrupted values (quotes/newlines/padding) are recovered and configured', async () => {
    const s = await startServer(BASE_PORT, {
      subject: PROD_SUBJECT,
      pub: `${keys.publicKey}=`,
      priv: keys.privateKey,
      nextPub: keys.publicKey,
      corrupt: true
    });
    try {
      const { cookie } = await apiSession(s.base);
      const { body, text } = await getPushState(s.base, cookie);
      assert.equal(body.data.configured, true, `incident class must be fixed — got reason=${body.data.configuredReason}`);
      assert.equal(body.data.publicKey, keys.publicKey, 'public key exposed normalized');
      assert.ok(!text.includes(keys.privateKey), 'private key must not appear');
    } finally {
      await s.stop();
    }
  });

  // ── Scenario 3: truly malformed credentials stay disabled, precisely ──
  await report.check('malformed credentials stay disabled with a precise safe reason', async () => {
    const s = await startServer(BASE_PORT, {
      subject: PROD_SUBJECT,
      pub: keys.publicKey.slice(0, 80),
      priv: keys.privateKey
    });
    try {
      const { cookie } = await apiSession(s.base);
      const { body, text } = await getPushState(s.base, cookie);
      assert.equal(body.data.configured, false, 'truncated key must keep push disabled');
      assert.equal(body.data.configuredReason, 'invalid-public-key');
      assert.equal(body.data.publicKey, null, 'no public key while misconfigured');
      assert.ok(!text.includes(keys.privateKey), 'private key must not appear');
      // The precise detail is safe rule text, not credential material.
      assert.ok(typeof body.data.configuredDetail === 'string' && body.data.configuredDetail.length > 0);
      assert.ok(!body.data.configuredDetail.includes(keys.privateKey));
    } finally {
      await s.stop();
    }
  });

  // ── Scenario 4: no VAPID at all — the card must stay visible and stable ──
  await report.check('push card stays visible with no Enable-UI flash when server has no VAPID', async () => {
    // Regression (production bug): the card flashed its Enable UI while the
    // capability fetch was in flight, then collapsed to the unavailable copy —
    // the push feature "appeared briefly and disappeared". The card must show
    // a neutral loading state first and NEVER flash the Enable UI when the
    // server is unconfigured, and it must never unmount.
    const s = await startServer(BASE_PORT, null);
    let browser: Browser | null = null;
    try {
      const { cookie } = await apiSession(s.base);
      browser = await puppeteer.launch({
        executablePath: requireChromiumExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
      const [name, value] = cookie.split('=');
      await page.setCookie({ name, value, domain: 'localhost', path: '/' });
      await page.goto(`${s.base}/app/settings`, { waitUntil: 'networkidle2', timeout: 45_000 });
      await page.waitForSelector('[data-testid="settings-tab-notifications"]', { timeout: 15_000 });
      await page.click('[data-testid="settings-tab-notifications"]');
      // Sample the card every 300ms for 8s: header always present, the Enable
      // control never present on an unconfigured server.
      let headerAll = true;
      let enableFlashed = false;
      let sawNotAvailable = false;
      for (let i = 0; i < 26; i++) {
        const snap = await page.evaluate(() => {
          const body = document.body.innerText;
          return {
            header: body.includes('Browser push'),
            enable: !!document.querySelector('[data-testid="enable-push-notifications"]'),
            unavailable: body.includes('not available on this server yet')
          };
        });
        if (!snap.header) headerAll = false;
        if (snap.enable) enableFlashed = true;
        if (snap.unavailable) sawNotAvailable = true;
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.ok(headerAll, 'the push card must remain visible for the whole window');
      assert.equal(enableFlashed, false, 'the Enable UI must never flash on an unconfigured server');
      assert.ok(sawNotAvailable, 'the unavailable state must be shown precisely');
      assert.deepEqual(pageErrors, [], 'no client exception may fire');
    } finally {
      await browser?.close();
      await s.stop();
    }
  });

  report.finish();
}

main().catch((err) => {
  if (exitOnBrowserBlocked(err)) return;
  console.error(err);
  process.exit(1);
});
