/**
 * Remediation H-2 — production hydration check (real browser).
 *
 * The toast portal used to render before mount, so every page logged React
 * #418/#423 in production. This suite asserts a clean console on load.
 *
 * Run: npm run test:hydration:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';
import { login, sleep, SERVER_URL, type Session } from './helpers';

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

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Passw0rd123', displayName, email: `${username}@example.com` })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function collectHydrationErrors(page: Page, url: string, cookieValue: string): Promise<string[]> {
  const errs: string[] = [];
  const onErr = (e: unknown) => errs.push(String((e as Error)?.message ?? e));
  page.on('pageerror', onErr);
  await page.setCookie({ name: 'linkup_session', value: cookieValue, domain: 'localhost', path: '/' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  page.off('pageerror', onErr);
  return errs;
}

async function main() {
  requireChromiumExecutable();
  console.log('■ hydration.browser: production pages hydrate cleanly');
  const stamp = Date.now().toString(36);
  const a = await register(`hy_${stamp}`, 'Hydration User');

  const browser: Browser = await puppeteer.launch({
    executablePath: requireChromiumExecutable(),
    headless: true,
    protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });

  try {
    const page = await browser.newPage();
    page.on('dialog', (d) => void d.dismiss());
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const me = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: a.username, password: 'Passw0rd123' })
    });
    const cookie = /linkup_session=([^;]+)/.exec(me.headers.get('set-cookie') ?? '');
    assert.ok(cookie, 'no session cookie');

    for (const route of ['/app/chats', '/app/status', '/app/settings']) {
      await check(`${route} loads with no React hydration errors`, async () => {
        const errs = await collectHydrationErrors(page, `${SERVER_URL}${route}`, cookie![1]);
        const hydration = errs.filter((e) => /418|423|Minified React error/.test(e));
        assert.equal(
          hydration.length,
          0,
          `hydration errors on ${route}: ${[...new Set(hydration)].join(' ;; ')}`
        );
      });
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} checks: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  if (exitOnBrowserBlocked(err)) return;
  console.error(err);
  process.exit(1);
});
