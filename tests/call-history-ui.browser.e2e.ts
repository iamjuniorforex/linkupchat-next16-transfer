/**
 * Call-history deletion UI (real browser).
 *
 * Verifies: the Calls page and the sidebar "Recent calls" expose a per-row
 * remove control, deletion is guarded by a confirmation dialog (cancel keeps
 * the row), successful deletion updates both surfaces immediately (no
 * reload), the peer's history is unaffected, and the flow works at a mobile
 * viewport.
 *
 * Run: npm run test:call-history:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';
import { api, connectSocket, login, sleep, SERVER_URL, type Session } from './helpers';
import { EVENTS } from '../shared/events';
import type { Socket } from 'socket.io-client';

const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'call-history-ui.browser.e2e.impl.log');
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

function capture<T = unknown>(socket: Socket, event: string): T[] {
  const items: T[] = [];
  socket.on(event, (p: T) => items.push(p));
  return items;
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
}

function emitOffer(socket: Socket, to: string, type: 'VOICE' | 'VIDEO' = 'VOICE') {
  socket.emit(EVENTS.CALL_OFFER, {
    callId: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: '',
    to,
    type,
    sdp: { type: 'offer', sdp: 'v=0-fake' }
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

async function callsList(s: Session): Promise<{ id: string; status: string }[]> {
  const res = await api<{ data?: { calls?: { id: string; status: string }[] } }>(s, 'GET', '/api/calls');
  assert.equal(res.status, 200);
  return res.json.data?.calls ?? [];
}

async function main() {
  requireChromiumExecutable();
  console.log('■ call-history-ui.browser: confirm + delete on desktop and mobile');
  const stamp = Date.now().toString(36);
  const a = await register(`chu_${stamp}`, 'History UI A');
  const b = await register(`chv_${stamp}`, 'History UI B');
  const bName = 'History UI B';

  const conv = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
    type: 'DIRECT',
    username: b.username
  });
  assert.equal(conv.status, 201, `DIRECT create: ${conv.status}`);

  const aSock = connectSocket(a);
  const bSock = connectSocket(b);
  await Promise.all([connected(aSock), connected(bSock)]);
  // The server registers call handlers after an async room-join on connect;
  // allow a settle beat before the first emit (same timing calls.e2e relies
  // on), and poll for delivery rather than assuming a fixed latency.
  await sleep(700);
  const bOffers = capture<{ callId: string }>(bSock, EVENTS.CALL_OFFER);
  emitOffer(aSock, b.id);
  await waitFor('first offer', async () => bOffers.length >= 1);
  const call1 = bOffers[0]!.callId;
  bSock.emit(EVENTS.CALL_REJECT, { callId: call1, to: a.id });
  emitOffer(aSock, b.id, 'VIDEO');
  await waitFor('second offer', async () => bOffers.length >= 2);
  const call2 = bOffers[1]!.callId;
  bSock.emit(EVENTS.CALL_REJECT, { callId: call2, to: a.id });
  await waitFor('both calls to conclude', async () => {
    const rows = await callsList(a);
    return (
      rows.some((r) => r.id === call1 && r.status !== 'RINGING') &&
      rows.some((r) => r.id === call2 && r.status !== 'RINGING')
    );
  });
  assert.notEqual(call1, call2);

  const removeLabel = `Remove ${bName} call from history`;
  const countRows = (page: Page, label: string) =>
    page.evaluate((l) => document.querySelectorAll(`[aria-label="${l}"]`).length, label);

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

    await page.goto(`${SERVER_URL}/app/calls`, { waitUntil: 'domcontentloaded' });
    await waitFor('call rows', async () => (await countRows(page, removeLabel)) >= 4);

    await check('both surfaces show each call with a remove control', async () => {
      // 2 calls × 2 surfaces (Calls page + sidebar "Recent calls").
      assert.equal(await countRows(page, removeLabel), 4, 'expected Calls page + sidebar rows');
    });

    // ── Cancel path: the confirmation dialog protects the entry.
    await check('deletion asks for confirmation; cancelling keeps the row', async () => {
      await page.click(`main [aria-label="${removeLabel}"]`);
      await waitFor('confirmation dialog', () => page.$('[data-testid="confirm-dialog-confirm"]'));
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(text.includes('Remove from your call history?'), 'dialog title missing');
      await page.click('[data-testid="confirm-dialog-cancel"]');
      await waitFor('dialog closed', async () => !(await page.$('[data-testid="confirm-dialog-confirm"]')));
      assert.equal(await countRows(page, removeLabel), 4, 'row disappeared after cancel');
    });

    // ── Confirm path: immediate removal from BOTH surfaces, no reload.
    // Rows list newest first, so the first remove control targets call2.
    await check('confirming removes the row from both surfaces immediately', async () => {
      await page.click(`main [aria-label="${removeLabel}"]`);
      await waitFor('confirmation dialog', () => page.$('[data-testid="confirm-dialog-confirm"]'));
      await page.click('[data-testid="confirm-dialog-confirm"]');
      await waitFor('row removed', async () => (await countRows(page, removeLabel)) === 2);
      assert.equal(await countRows(page, removeLabel), 2, 'sidebar did not update immediately');
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(text.includes('Call removed from your history'), 'success toast missing');
    });

    await check("peer's history is unaffected by the UI deletion", async () => {
      assert.ok((await callsList(b)).some((c) => c.id === call2), 'peer lost the deleted call');
      assert.ok(!(await callsList(a)).some((c) => c.id === call2), 'deletion not persisted');
      assert.ok((await callsList(a)).some((c) => c.id === call1), 'wrong call was deleted');
    });

    // ── Mobile viewport: the sidebar list is the visible surface.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.goto(`${SERVER_URL}/app/calls`, { waitUntil: 'domcontentloaded' });
    await waitFor('call rows (mobile)', async () => (await countRows(page, removeLabel)) >= 2);

    await check('mobile: remove control is visible within the viewport', async () => {
      const box = await page.evaluate((l) => {
        const el = document.querySelector(`[aria-label="${l}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
      }, removeLabel);
      assert.ok(box, 'remove control not found');
      assert.ok(box!.w > 0 && box!.h > 0, 'remove control has no size');
      assert.ok(box!.x >= 0 && box!.y >= 0 && box!.x + box!.w <= box!.vw + 1 && box!.y + box!.h <= box!.vh + 1, 'remove control off-viewport');
    });

    await check('mobile: confirming deletion removes the call immediately', async () => {
      await page.click(`[aria-label="${removeLabel}"]`);
      await waitFor('confirmation dialog (mobile)', () => page.$('[data-testid="confirm-dialog-confirm"]'));
      await page.click('[data-testid="confirm-dialog-confirm"]');
      await waitFor('row removed (mobile)', async () => (await countRows(page, removeLabel)) === 0);
      assert.equal(await countRows(page, removeLabel), 0);
      assert.ok(!(await callsList(a)).some((c) => c.id === call1), 'deletion not persisted');
    });
  } finally {
    await browser.close();
    aSock.disconnect();
    bSock.disconnect();
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  if (exitOnBrowserBlocked(err)) return;
  console.error(err);
  process.exit(1);
});
