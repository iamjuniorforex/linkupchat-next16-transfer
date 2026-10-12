/**
 * Phase 5B Part 1 — status UI foundation (real browser).
 *
 * Covers: posting a TEXT status and an IMAGE status (existing upload
 * pipeline, purpose=status → attachmentId) from /app/status, their appearance
 * under "My statuses", and the merged story rail chip in the sidebar.
 *
 * Run: npm run test:status:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';
import { api, login, sleep, SERVER_URL, type Session } from './helpers';

const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'status-ui.browser.e2e.impl.log');
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

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Passw0rd123', displayName, email: `${username}@example.com` })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function openComposer(page: Page) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent!.includes('Add status'));
    b!.click();
  });
  await waitFor('composer', async () => await page.$('textarea[aria-label="Status text"]'));
}

async function main() {
  requireChromiumExecutable();
  console.log('■ status-ui.browser: post text + image statuses from the UI');
  const stamp = Date.now().toString(36);
  const a = await register(`su_${stamp}`, 'Status UI User');

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
    await page.setViewport({ width: 1280, height: 800 });
    const me = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: a.username, password: 'Passw0rd123' })
    });
    const cookie = /linkup_session=([^;]+)/.exec(me.headers.get('set-cookie') ?? '');
    assert.ok(cookie, 'no session cookie');
    await page.setCookie({ name: 'linkup_session', value: cookie![1], domain: 'localhost', path: '/' });

    await page.goto(`${SERVER_URL}/app/status`, { waitUntil: 'domcontentloaded' });
    await waitFor('status page', async () => await page.evaluate(() => document.body.innerText.includes('Add status')));

    await check('posting a text status shows it under "My statuses"', async () => {
      await openComposer(page);
      await page.type('textarea[aria-label="Status text"]', 'Hello from the status UI');
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent!.trim().endsWith('Post'));
        b!.click();
      });
      await waitFor('text status listed', async () =>
        await page.evaluate(() => document.body.innerText.includes('Hello from the status UI'))
      );
    });

    await check('posting an image status goes through the upload pipeline and lands under "My statuses"', async () => {
      await openComposer(page);
      const pngPath = path.join(ARTIFACTS, 'status-ui-upload.png');
      fs.writeFileSync(pngPath, PNG_BYTES);
      const input = (await page.$('input[type="file"]'))!;
      await input.uploadFile(pngPath);
      await waitFor('image preview', async () => await page.$('img[alt="Preview"]'));
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent!.trim().endsWith('Post'));
        b!.click();
      });
      await waitFor('media status listed', async () =>
        await page.evaluate(() => document.body.innerText.includes('Media update'))
      );
    });

    await check('the sidebar story rail shows the merged "My status" chip', async () => {
      // The rail (StatusList) renders in the sidebar's status section.
      await page.goto(`${SERVER_URL}/app/status`, { waitUntil: 'domcontentloaded' });
      await waitFor('my status chip', async () =>
        await page.$(`[aria-label="${a.username ? "Status UI User's status updates" : ''}"]`)
      );
    });

    await check('server state: both statuses are active and attachment-backed', async () => {
      const res = await api<{ data?: { statuses?: { type: string; mediaUrl?: string | null }[] } }>(a, 'GET', '/api/status/me');
      assert.equal(res.status, 200);
      const rows = res.json.data?.statuses ?? [];
      assert.equal(rows.length, 2, `expected 2 statuses, got ${rows.length}`);
      assert.ok(rows.some((r) => r.type === 'TEXT'));
      const img = rows.find((r) => r.type === 'IMAGE');
      assert.ok(img, 'image status missing');
      assert.ok(img!.mediaUrl?.includes('/api/files/'), `mediaUrl=${img!.mediaUrl}`);
    });
  } finally {
    await browser.close();
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  if (exitOnBrowserBlocked(err)) return;
  console.error(err);
  process.exit(1);
});
