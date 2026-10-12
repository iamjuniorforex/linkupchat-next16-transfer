/**
 * Phase 5B Part 2 — mobile "Add status" UX (real browser, phone viewport).
 *
 * On phones the sidebar story rail IS the whole Status screen (the status
 * page pane is collapsed to 0px), so the add control must live there and
 * open the single existing composer.
 *
 * Covers: an obvious "Add status" control associated with "My status", that
 * tapping it opens the one existing composer (no second composer), that
 * posting works from it, and that the control stays available when the user
 * already has active statuses.
 *
 * Run: npm run test:status:add-mobile:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';
import { login, sleep, SERVER_URL, type Session } from './helpers';

const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'status-add-mobile.browser.e2e.impl.log');
fs.mkdirSync(ARTIFACTS, { recursive: true });

let passed = 0;
let failed = 0;
const implLines: string[] = [];
function ilog(line: string) {
  implLines.push(line);
  fs.writeFileSync(IMPL_LOG, implLines.join('\n') + '\n');
}
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
      ilog(`PASS ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
      ilog(`FAIL ${name}: ${(err as Error).message}`);
    });
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for: ${label}`);
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

async function clickTestId(page: Page, testid: string) {
  await page.evaluate((tid) => {
    const b = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null;
    b?.click();
  }, testid);
}

async function composerOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.querySelector('textarea[aria-label="Status text"]')));
}

async function postFromComposer(page: Page, text: string) {
  await waitFor('composer', async () => await composerOpen(page));
  await page.type('textarea[aria-label="Status text"]', text);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent!.trim().endsWith('Post'));
    b!.click();
  });
  await waitFor('composer closed', async () => !(await composerOpen(page)));
}

async function main() {
  requireChromiumExecutable();
  console.log('■ status-add-mobile: obvious add control on phones');
  const stamp = Date.now().toString(36);
  const u = await register(`sa_${stamp}`, 'Status Add Mobile');

  const browser: Browser = await puppeteer.launch({
    executablePath: requireChromiumExecutable(),
    headless: true,
    protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });

  try {
    const page = await browser.newPage();
    page.on('dialog', (d) => void d.dismiss());
    page.on('pageerror', (e) => ilog(`[pageerror] ${String((e as Error)?.message ?? e)}`));
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const me = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: u.username, password: 'Passw0rd123' })
    });
    const cookie = /linkup_session=([^;]+)/.exec(me.headers.get('set-cookie') ?? '');
    assert.ok(cookie, 'no session cookie');
    await page.setCookie({ name: 'linkup_session', value: cookie![1], domain: 'localhost', path: '/' });

    await page.goto(`${SERVER_URL}/app/status`, { waitUntil: 'domcontentloaded' });
    await waitFor('add control', async () => await page.$('[data-testid="list-add-status"]'));

    await check('a clear "Add status" control is visible on the phone Status screen, next to "My status"', async () => {
      const info = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="list-add-status"]');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        // The control must be visibly associated with the "My status" row.
        let node: HTMLElement | null = btn as HTMLElement;
        let associated = false;
        for (let i = 0; i < 5 && node; i++) {
          if ((node.textContent ?? '').includes('My status')) {
            associated = true;
            break;
          }
          node = node.parentElement;
        }
        return { width: rect.width, height: rect.height, top: rect.top, associated };
      });
      assert.ok(info, 'list add control missing');
      assert.ok(info!.width > 0 && info!.height >= 30, `control not tappable: ${info!.width}x${info!.height}`);
      assert.ok(info!.top >= 0 && info!.top < 844, 'control is outside the phone viewport');
      assert.ok(info!.associated, 'control is not visually tied to "My status"');
      const labeled = await page.evaluate(
        () => Array.from(document.querySelectorAll('[aria-label="Add status"]')).length
      );
      assert.ok(labeled >= 1, 'no accessible "Add status" label found');
    });

    await check('tapping it opens the one existing composer (no second composer)', async () => {
      await clickTestId(page, 'list-add-status');
      await waitFor('composer open', async () => await composerOpen(page));
      const state = await page.evaluate(() => {
        const composers = document.querySelectorAll('textarea[aria-label="Status text"]');
        const title = Array.from(document.querySelectorAll('h2, h3, p, div')).some((x) =>
          (x.textContent ?? '').trim() === 'Add to your status'
        );
        return { composers: composers.length, title };
      });
      assert.equal(state.composers, 1, `expected 1 composer, found ${state.composers}`);
      assert.ok(state.title, 'composer title "Add to your status" missing');
      await postFromComposer(page, 'Mobile first update');
      await waitFor('rail shows the new status', async () =>
        await page.evaluate(() => document.body.innerText.includes('1 update'))
      );
    });

    await check('with active statuses the same area still offers "Add status"', async () => {
      // The me chip now carries the add badge and the list row remains.
      await waitFor('rail add badge', async () => await page.$('[data-testid="rail-add-status"]'));
      const stillThere = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="list-add-status"]');
        return Boolean(list && list.getBoundingClientRect().width > 0);
      });
      assert.ok(stillThere, 'list add control disappeared after posting');

      await clickTestId(page, 'rail-add-status');
      await postFromComposer(page, 'Mobile second update');
      await waitFor('two updates listed', async () =>
        await page.evaluate(() => document.body.innerText.includes('2 updates'))
      );
    });
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
