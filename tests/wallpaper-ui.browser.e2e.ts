/**
 * Chat wallpaper UI (real browser).
 *
 * Verifies that the Settings → Chat wallpaper picker is wired to the real
 * state AND rendering: selecting a wallpaper changes the conversation surface
 * (direct AND group), the selection survives refresh and navigation, switching
 * between two wallpapers restyles the surface, 'default' restores the themed
 * gradient, dark theme still resolves the theme-aware default, and the picker
 * works at a mobile viewport.
 *
 * Run: npm run test:wallpaper:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';
import { SERVER_URL, api, login, uniq, type Session } from './helpers';

const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'wallpaper-ui.browser.e2e.impl.log');
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

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Passw0rd123', displayName, email: `${username}@example.com` })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

/** Computed background-image of the conversation messages surface. */
async function chatBackground(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('div[role="log"][aria-label="Conversation messages"]');
    return el ? getComputedStyle(el).backgroundImage : null;
  });
}

async function openConversation(page: Page, id: string) {
  await page.goto(`${SERVER_URL}/app/chats/${id}`, { waitUntil: 'domcontentloaded' });
  await waitFor('conversation surface', () => page.$('div[role="log"][aria-label="Conversation messages"]'));
}

async function pickWallpaper(page: Page, name: 'default' | 'aurora' | 'plain') {
  await page.goto(`${SERVER_URL}/app/settings`, { waitUntil: 'domcontentloaded' });
  await waitFor('settings tabs', () => page.$('[data-testid="settings-tab-chat"]'));
  await page.click('[data-testid="settings-tab-chat"]');
  await waitFor(`wallpaper "${name}" picker`, () => page.$(`[data-testid="wallpaper-${name}"]`));
  await page.click(`[data-testid="wallpaper-${name}"]`);
  const saved = await waitFor('save toast', async () => await page.evaluate(() => document.body.innerText.includes('Setting saved')));
  assert.ok(saved, 'no "Setting saved" toast');
}

async function main() {
  requireChromiumExecutable();
  console.log('■ wallpaper-ui.browser: selection renders and persists');
  const a = await register(`wpu_${uniq().replace(/-/g, '')}`, 'Wallpaper User');
  const b = await register(`wpf_${uniq().replace(/-/g, '')}`, 'Wallpaper Friend');

  const direct = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', { type: 'DIRECT', username: b.username });
  assert.equal(direct.status, 201, `DIRECT create: ${direct.status}`);
  const directId = direct.json.data!.conversation!.id!;
  const group = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
    type: 'GROUP',
    title: 'Wallpaper Group',
    memberIds: [b.id]
  });
  assert.equal(group.status, 201, `GROUP create: ${group.status}`);
  const groupId = group.json.data!.conversation!.id!;
  for (const cid of [directId, groupId]) {
    const msg = await api(a, 'POST', `/api/conversations/${cid}/messages`, { type: 'TEXT', content: 'Wallpaper check' });
    assert.equal(msg.status, 201, `send message: ${msg.status}`);
  }

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

    // ── 1. Default wallpaper is the themed gradient (behavior preserved).
    await openConversation(page, directId);
    await check('default wallpaper renders the themed gradient', async () => {
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('radial-gradient'), `background=${bg}`);
    });

    await check('messages remain rendered over the wallpaper (readability)', async () => {
      const ok = await page.evaluate(() => {
        const walker = document.evaluate("//*[contains(text(), 'Wallpaper check')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < walker.snapshotLength; i++) {
          let el: HTMLElement | null = walker.snapshotItem(i) as HTMLElement | null;
          for (let hop = 0; el && hop < 5; hop++, el = el.parentElement) {
            const bg = getComputedStyle(el).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)') return true;
          }
        }
        return false;
      });
      assert.ok(ok, 'message bubble has no solid surface behind its text');
    });

    // ── 2. Selecting a wallpaper applies it to the active conversation.
    await pickWallpaper(page, 'aurora');
    await openConversation(page, directId);
    await check("selecting 'aurora' applies it to the direct conversation", async () => {
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('135deg'), `background=${bg}`);
    });

    await openConversation(page, groupId);
    await check("'aurora' also applies to group conversations", async () => {
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('135deg'), `background=${bg}`);
    });

    // ── 3. Persistence: history navigation and full refresh.
    await check('wallpaper survives SPA history navigation', async () => {
      await page.goBack();
      await waitFor('conversation surface (back)', () => page.$('div[role="log"][aria-label="Conversation messages"]'));
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('135deg'), `background=${bg}`);
    });

    await check('wallpaper survives a full page refresh', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor('conversation surface (reload)', () => page.$('div[role="log"][aria-label="Conversation messages"]'));
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('135deg'), `background=${bg}`);
    });

    // ── 4. Switching between two wallpapers restyles the surface.
    await pickWallpaper(page, 'plain');
    await openConversation(page, directId);
    await check("switching to 'plain' replaces 'aurora' on the surface", async () => {
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('linear-gradient'), `background=${bg}`);
      assert.ok(!bg!.includes('135deg'), 'aurora still applied');
      assert.ok(!bg!.includes('radial-gradient'), 'default still applied');
    });

    // ── 5. 'default' restores the themed gradient.
    await pickWallpaper(page, 'default');
    await openConversation(page, directId);
    await check("selecting 'default' restores the themed gradient", async () => {
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('radial-gradient'), `background=${bg}`);
    });

    // ── 6. Dark theme: the default wallpaper follows the theme (unchanged).
    // ThemeProvider resolves SYSTEM from prefers-color-scheme (localStorage is
    // its source of truth), so emulate OS dark — the existing theme mechanism.
    await check('dark theme keeps the theme-aware default wallpaper', async () => {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await waitFor('dark theme applied', () => page.evaluate(() => document.documentElement.classList.contains('dark')));
      await openConversation(page, directId);
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('12, 14, 26'), `dark wallpaper background=${bg}`);
    });

    // ── 7. Mobile viewport: picker works and the wallpaper applies.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await pickWallpaper(page, 'aurora');
    await openConversation(page, directId);
    await check('mobile: wallpaper applies and the composer stays usable', async () => {
      const bg = await chatBackground(page);
      assert.ok(bg && bg.includes('135deg'), `background=${bg}`);
      const box = await page.evaluate(() => {
        const el = document.querySelector('form textarea, form input[type="text"], textarea');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, w: r.width, y: r.y, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
      });
      assert.ok(box, 'composer input not found');
      assert.ok(box!.w > 100, `composer collapsed (${box!.w}px)`);
      assert.ok(box!.x >= 0 && box!.x + box!.w <= box!.vw + 1, 'composer off-viewport horizontally');
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
