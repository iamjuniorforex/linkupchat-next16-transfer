/**
 * Phase 5A — profile editing UI (real browser).
 *
 * Opens the real settings page, edits display name / username / About through
 * genuine keyboard input, checks inline validation errors + success feedback,
 * and uploads a real photo through the avatar file input.
 *
 * Run: npm run test:profile:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';
const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'profile-ui.browser.e2e.impl.log');
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Select-all + type (real keystrokes so React state updates). */
async function replaceValue(page: Page, selector: string, value: string) {
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (value) await page.keyboard.type(value);
}

const bodyHas = async (page: Page, text: string) =>
  page.evaluate((t) => document.body.innerText.includes(t), text);

async function main() {
  requireChromiumExecutable();
  console.log('■ profile-ui.browser: edit profile experience');
  const username = `pui_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = 'Passw0rd123';

  // Disposable account (register requires email or phone).
  const reg = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, displayName: 'UI Tester', email: `${username}@example.com` })
  });
  assert.ok(reg.ok, `register failed: ${reg.status} ${await reg.text()}`);

  // Real PNG fixture for the avatar upload (valid magic bytes).
  const fixture = path.join(ARTIFACTS, 'profile-avatar-fixture.png');
  fs.writeFileSync(fixture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')); // real 1x1 PNG

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

    // API login + cookie injection (deterministic; no UI login races).
    const login = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: username, password })
    });
    assert.ok(login.ok, `login failed: ${login.status}`);
    const cookie = /linkup_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '');
    assert.ok(cookie, 'session cookie captured');
    await page.goto(`${SERVER_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.setCookie({ name: 'linkup_session', value: cookie![1], url: SERVER_URL });

    await check('settings page loads with the full profile form', async () => {
      await page.goto(`${SERVER_URL}/app/settings`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('[data-testid="profile-display-name"]', { timeout: 15000 });
      for (const sel of ['profile-username', 'profile-about', 'profile-save', 'profile-avatar-input']) {
        assert.ok(await page.$(`[data-testid="${sel}"]`), `${sel} present`);
      }
      assert.equal(await page.$eval('[data-testid="profile-display-name"]', (el) => (el as HTMLInputElement).value), 'UI Tester');
      assert.equal(await page.$eval('[data-testid="profile-username"]', (el) => (el as HTMLInputElement).value), username);
    });

    await check('invalid display name shows an INLINE validation error and does not save', async () => {
      await replaceValue(page, '[data-testid="profile-display-name"]', '');
      await page.click('[data-testid="profile-save"]');
      await waitFor('inline error', async () => await bodyHas(page, 'Display name must be at least 2 characters.'));
      // server state unchanged
      const me = await page.evaluate(async () => {
        const r = await fetch('/api/auth/me');
        return (await r.json()) as { data?: { displayName: string } };
      });
      assert.equal(me.data?.displayName, 'UI Tester');
    });

    await check('display name + About save with success feedback and persist', async () => {
      await replaceValue(page, '[data-testid="profile-display-name"]', 'Ada 👩🏾‍💻');
      await replaceValue(page, '[data-testid="profile-about"]', 'Building things that matter.');
      await page.click('[data-testid="profile-save"]');
      await waitFor('success toast', async () => await bodyHas(page, 'Profile updated'));
      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForSelector('[data-testid="profile-display-name"]');
      assert.equal(await page.$eval('[data-testid="profile-display-name"]', (el) => (el as HTMLInputElement).value), 'Ada 👩🏾‍💻');
      assert.equal(await page.$eval('[data-testid="profile-about"]', (el) => (el as HTMLTextAreaElement).value), 'Building things that matter.');
    });

    await check('invalid username shows an inline error; valid username saves', async () => {
      await replaceValue(page, '[data-testid="profile-username"]', 'Bad Name!');
      await page.click('[data-testid="profile-save"]');
      await waitFor('username inline error', async () =>
        await bodyHas(page, 'Use 3–24 lowercase letters, numbers or underscores.')
      );
      const newName = `ren_${Date.now().toString(36)}`;
      await replaceValue(page, '[data-testid="profile-username"]', newName);
      await page.click('[data-testid="profile-save"]');
      await waitFor('username saved', async () => await bodyHas(page, 'Profile updated'));
      const me = await page.evaluate(async () => {
        const r = await fetch('/api/auth/me');
        return (await r.json()) as { data?: { username: string } };
      });
      assert.equal(me.data?.username, newName);
    });

    await check('About counter tracks the input', async () => {
      await replaceValue(page, '[data-testid="profile-about"]', 'Hello!');
      const text = await page.$eval('[data-testid="profile-about-count"]', (el) => el.textContent ?? '');
      assert.equal(text.trim(), '6/140 characters');
    });

    await check('avatar: real photo upload via the file input updates the profile', async () => {
      const input = (await page.$('[data-testid="profile-avatar-input"]')) as {
        uploadFile: (path: string) => Promise<void>;
      } | null;
      assert.ok(input);
      await input!.uploadFile(fixture);
      await waitFor('photo updated toast', async () => await bodyHas(page, 'Photo updated'), 20000);
      await waitFor('avatar applied', async () => {
        const me = await page.evaluate(async () => {
          const r = await fetch('/api/auth/me');
          return (await r.json()) as { data?: { avatarUrl: string | null } };
        });
        return me.data?.avatarUrl ? me : null;
      });
      // the rendered avatar shows the uploaded photo (decoded, not broken)
      await waitFor('img rendered and decoded', async () =>
        await page.evaluate(() =>
          Array.from(document.querySelectorAll('img')).some((i) => (i as HTMLImageElement).naturalWidth > 0)
        )
      );
    });

    await check('taken username shows the server error inline', async () => {
      await replaceValue(page, '[data-testid="profile-username"]', 'alex');
      await page.click('[data-testid="profile-save"]');
      await waitFor('taken error', async () => await bodyHas(page, 'That username is already taken.'));
    });
  } finally {
    await browser.close();
  }

  console.log('════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (exitOnBrowserBlocked(err)) return;
  console.error(err);
  process.exit(1);
});
