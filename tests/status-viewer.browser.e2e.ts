/**
 * Phase 5B Part 2 — status viewer navigation (real browser, mobile viewport).
 *
 * Covers: tap zones (left half = previous, right half = next), the visible
 * Previous/Next controls, keyboard arrows, advancing across authors through
 * every status the viewer may see, and that expired/deleted statuses are
 * excluded from navigation.
 *
 * Run: npm run test:status:viewer:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';
import { api, login, sleep, SERVER_URL, type Session } from './helpers';
import { db } from '../src/lib/db';

const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'status-viewer.browser.e2e.impl.log');
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

async function postText(s: Session, content: string) {
  const res = await api<{ ok?: boolean; data?: { status?: { id: string } } }>(s, 'POST', '/api/status', {
    type: 'TEXT',
    content,
    background: 'linear-gradient(135deg, #6D5EF5 0%, #22B8FF 100%)'
  });
  assert.equal(res.status, 201, `post "${content}": ${res.status}`);
  return res.json.data!.status!.id;
}

async function viewerText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-testid="status-viewer-card"]');
    return card ? (card.textContent ?? '') : '';
  });
}

async function viewerOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.querySelector('[data-testid="status-viewer-card"]')));
}

async function openChip(page: Page, displayName: string) {
  await page.evaluate((name) => {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => x.getAttribute('aria-label') === `${name}'s status updates`
    );
    b?.click();
  }, displayName);
  await waitFor('viewer open', async () => await viewerOpen(page));
}

async function tapSide(page: Page, side: 'left' | 'right') {
  const box = await (await page.$('[data-testid="status-viewer-card"]'))!.boundingBox();
  assert.ok(box, 'viewer card has no box');
  await page.mouse.click(box.x + box.width * (side === 'left' ? 0.15 : 0.85), box.y + box.height * 0.5);
  await sleep(150);
}

async function clickControl(page: Page, testid: 'status-next' | 'status-prev') {
  await page.evaluate((tid) => {
    const b = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null;
    b?.click();
  }, testid);
  await sleep(150);
}

async function main() {
  requireChromiumExecutable();
  console.log('■ status-viewer.browser: next/previous navigation');
  const stamp = Date.now().toString(36);
  const v = await register(`sv_${stamp}`, 'Status Viewer');
  const bee = await register(`svb_${stamp}`, 'Author Bee');
  const sea = await register(`svc_${stamp}`, 'Author Sea');

  await api(v, 'POST', '/api/contacts', { userId: bee.id });
  await api(v, 'POST', '/api/contacts', { userId: sea.id });

  const beeOne = await postText(bee, 'Bee-one unique line');
  const beeTwo = await postText(bee, 'Bee-two unique line');
  const seaOne = await postText(sea, 'Sea-one unique line');
  const ownOne = await postText(v, 'Own-one unique line');
  void beeOne;
  void ownOne;

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
      body: JSON.stringify({ identifier: v.username, password: 'Passw0rd123' })
    });
    const cookie = /linkup_session=([^;]+)/.exec(me.headers.get('set-cookie') ?? '');
    assert.ok(cookie, 'no session cookie');
    await page.setCookie({ name: 'linkup_session', value: cookie![1], domain: 'localhost', path: '/' });

    await page.goto(`${SERVER_URL}/app/status`, { waitUntil: 'domcontentloaded' });
    await waitFor('rail chip', async () =>
      await page.$(`[aria-label="Author Bee's status updates"]`)
    );

    await check('tap zones: right side advances, left side goes back', async () => {
      await openChip(page, 'Author Bee');
      const first = await viewerText(page);
      assert.ok(first.includes('Bee-one') || first.includes('Bee-two'), 'expected a Bee status');
      await tapSide(page, 'right');
      const second = await viewerText(page);
      assert.notEqual(second, first, 'right tap should show a different status');
      assert.ok(second.includes('Bee-one') || second.includes('Bee-two'), 'still within Bee');
      await tapSide(page, 'left');
      const back = await viewerText(page);
      assert.equal(back, first, 'left tap should return to the previous status');
    });

    await check('visible Previous/Next controls work', async () => {
      const first = await viewerText(page);
      await clickControl(page, 'status-next');
      const second = await viewerText(page);
      assert.notEqual(second, first, 'Next control should advance');
      await clickControl(page, 'status-prev');
      assert.equal(await viewerText(page), first, 'Previous control should go back');
    });

    await check('keyboard arrow keys work', async () => {
      const first = await viewerText(page);
      await page.keyboard.press('ArrowRight');
      await sleep(150);
      const second = await viewerText(page);
      assert.notEqual(second, first, 'ArrowRight should advance');
      await page.keyboard.press('ArrowLeft');
      await sleep(150);
      assert.equal(await viewerText(page), first, 'ArrowLeft should go back');
    });

    await check('the viewer advances through all allowed statuses (across authors)', async () => {
      // Close, then start from the FIRST rail chip and walk forward to the end.
      await page.evaluate(() => {
        const close = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Close');
        close?.click();
      });
      await sleep(250);
      await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('button')).filter((x) =>
          (x.getAttribute('aria-label') ?? '').endsWith("'s status updates")
        );
        (chips[0] as HTMLElement | undefined)?.click();
      });
      await waitFor('viewer open', async () => await viewerOpen(page));
      const seen = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const text = await viewerText(page);
        if (!text) break;
        for (const marker of ['Bee-one unique line', 'Bee-two unique line', 'Sea-one unique line', 'Own-one unique line']) {
          if (text.includes(marker)) seen.add(marker);
        }
        if (!(await viewerOpen(page))) break;
        await clickControl(page, 'status-next');
        await sleep(250);
        if (!(await viewerOpen(page))) break;
      }
      for (const marker of ['Bee-one unique line', 'Bee-two unique line', 'Sea-one unique line', 'Own-one unique line']) {
        assert.ok(seen.has(marker), `navigation never reached "${marker}" (saw: ${[...seen].join(', ')})`);
      }
    });

    await check('expired and deleted statuses are excluded from navigation', async () => {
      await page.evaluate(() => {
        const close = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Close');
        close?.click();
      });
      await sleep(250);

      // Expire Sea's status and delete one of Bee's — via the database,
      // exactly like the server-side 24h filter would treat them.
      await db.status.update({ where: { id: seaOne }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      await db.status.update({ where: { id: beeOne }, data: { deletedAt: new Date() } });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor('rail chip after reload', async () =>
        await page.$(`[aria-label="Author Bee's status updates"]`)
      );
      await openChip(page, 'Author Bee');

      const seen = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const text = await viewerText(page);
        if (!text) break;
        for (const marker of ['Bee-one unique line', 'Bee-two unique line', 'Sea-one unique line']) {
          if (text.includes(marker)) seen.add(marker);
        }
        if (!(await viewerOpen(page))) break;
        await clickControl(page, 'status-next');
        await sleep(250);
        if (!(await viewerOpen(page))) break;
      }
      assert.ok(!seen.has('Bee-one unique line'), 'deleted status must not be reachable');
      assert.ok(!seen.has('Sea-one unique line'), 'expired status must not be reachable');
      assert.ok(seen.has('Bee-two unique line'), 'the surviving status must stay reachable');
    });

    // ── End state + delete-while-viewing (isolated user, deterministic) ──
    const v2 = await register(`svf_${stamp}`, 'Status Final');
    const fay = await register(`svy_${stamp}`, 'Author Fay');
    await api(v2, 'POST', '/api/contacts', { userId: fay.id });
    await postText(fay, 'Fay only line');

    const page2 = await browser.newPage();
    page2.on('dialog', (d) => void d.dismiss());
    page2.on('pageerror', (e) => ilog(`[pageerror] ${String((e as Error)?.message ?? e)}`));
    await page2.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const login2 = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: v2.username, password: 'Passw0rd123' })
    });
    const cookie2 = /linkup_session=([^;]+)/.exec(login2.headers.get('set-cookie') ?? '');
    assert.ok(cookie2, 'no session cookie for v2');
    await page2.setCookie({ name: 'linkup_session', value: cookie2![1], domain: 'localhost', path: '/' });
    await page2.goto(`${SERVER_URL}/app/status`, { waitUntil: 'domcontentloaded' });

    await check('reaching the final status and pressing next closes the viewer (end state)', async () => {
      await waitFor('fay chip', async () => await page2.$(`[aria-label="Author Fay's status updates"]`));
      await openChip(page2, 'Author Fay');
      assert.ok((await viewerText(page2)).includes('Fay only line'), "expected Fay's status");
      await clickControl(page2, 'status-next');
      await sleep(350);
      assert.equal(await viewerOpen(page2), false, 'next at the final status should close the viewer');
    });

    await check('deleting the currently-viewed status advances to the next valid one (or closes at the end)', async () => {
      await postText(v2, 'Final own one');
      await postText(v2, 'Final own two');
      await page2.reload({ waitUntil: 'domcontentloaded' });
      await waitFor('me chip', async () => await page2.$(`[aria-label="Status Final's status updates"]`));
      await openChip(page2, 'Status Final');
      const first = await viewerText(page2);
      assert.ok(first.includes('Final own'), `expected own status, got: ${first}`);

      await page2.evaluate(() => {
        (document.querySelector('[data-testid="viewer-delete-status"]') as HTMLElement | null)?.click();
      });
      await waitFor('confirm dialog', async () => await page2.$('[data-testid="confirm-dialog-confirm"]'));
      await page2.evaluate(() => {
        (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement | null)?.click();
      });
      await sleep(400);
      assert.equal(await viewerOpen(page2), true, 'viewer should advance, not close');
      const second = await viewerText(page2);
      assert.notEqual(second, first, 'the next valid status should be shown');
      assert.ok(second.includes('Final own'), `expected another own status, got: ${second}`);

      await page2.evaluate(() => {
        (document.querySelector('[data-testid="viewer-delete-status"]') as HTMLElement | null)?.click();
      });
      await waitFor('confirm dialog 2', async () => await page2.$('[data-testid="confirm-dialog-confirm"]'));
      await page2.evaluate(() => {
        (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement | null)?.click();
      });
      await sleep(400);
      assert.equal(await viewerOpen(page2), false, 'viewer should close when nothing is left');
      await page2.close();
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
