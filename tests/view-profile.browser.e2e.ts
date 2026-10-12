/**
 * View-Profile navigation regression (real browser).
 *
 * Reproduces the production bug: Account 1 opens a conversation with
 * Account 2 (who has a profile picture) and taps "View profile". Before the
 * fix, /app/u/[username] was missing from the app layout's mobile
 * hide-sidebar rule, so the full-width sidebar collapsed the main pane to
 * 0px — the profile page was never visible and the screen looked like it had
 * "returned to the previous screen".
 *
 * Covers: the profile API returns the other user (with avatar) to the viewer,
 * the tap flow navigates and the profile pane is actually visible on mobile,
 * display name / username / About / profile picture render, back navigation
 * returns to the conversation, and the desktop layout keeps working.
 *
 * Run: npm run test:view-profile:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';
import { api, login, sleep, SERVER_URL, type Session } from './helpers';

const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'view-profile.browser.e2e.impl.log');
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

async function uploadAvatar(s: Session): Promise<string> {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(PNG_BYTES)], 'avatar.png', { type: 'image/png' }), 'avatar.png');
  fd.append('purpose', 'avatar');
  const res = await fetch(`${SERVER_URL}/api/upload`, { method: 'POST', body: fd, headers: { Cookie: s.cookie } });
  const json = (await res.json()) as { ok?: boolean; data?: { url?: string; kind?: string } };
  assert.equal(res.status, 200, `upload: ${res.status}`);
  assert.equal(json.data?.kind, 'AVATAR');
  return json.data!.url!;
}

/** Tap "View profile" from the open conversation (header → Contact info). */
async function tapViewProfile(page: Page, peerName: string) {
  await waitFor('conversation header', async () =>
    await page.evaluate((name) => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => typeof b.className === 'string' && b.className.includes('min-w-0') && (b.textContent ?? '').includes(name)
      );
      if (!btn) return false;
      btn.click();
      return true;
    }, peerName)
  );
  await waitFor('Contact info dialog', async () => await page.evaluate(() => document.body.innerText.includes('View profile')));
  await waitFor('View profile tap', async () =>
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent ?? '').trim().includes('View profile'));
      if (!b) return false;
      b.click();
      return true;
    })
  );
}

async function profileState(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const r = main ? main.getBoundingClientRect() : null;
    // Scope to the main pane: the sidebar shows the same peer name/avatar.
    const root = main ?? document.body;
    const img = Array.from(root.querySelectorAll('img')).find((i) => i.src.includes('/api/files/'));
    const imgBox = img ? img.getBoundingClientRect() : null;
    return {
      url: location.pathname,
      mainWidth: r ? Math.round(r.width) : 0,
      text: root.innerText,
      avatarRendered: Boolean(img && imgBox && imgBox.width > 0 && imgBox.height > 0)
    };
  });
}

async function main() {
  requireChromiumExecutable();
  console.log('■ view-profile.browser: View Profile navigation regression');
  const stamp = Date.now().toString(36);
  const a = await register(`vv_${stamp}`, 'Viewer Account');
  const b = await register(`vt_${stamp}`, 'Target Account');

  const avatarUrl = await uploadAvatar(b);
  const patch = await api(b, 'PATCH', '/api/users/me', { avatarUrl });
  assert.equal(patch.status, 200, `avatar attach: ${patch.status}`);

  const conv = await api<{ data?: { conversation?: { id?: string } } }>(a, 'POST', '/api/conversations', {
    type: 'DIRECT',
    username: b.username
  });
  assert.equal(conv.status, 201, `DIRECT create: ${conv.status}`);
  const convId = conv.json.data!.conversation!.id!;
  const msg = await api(a, 'POST', `/api/conversations/${convId}/messages`, { type: 'TEXT', content: 'hello there' });
  assert.equal(msg.status, 201);

  await check('profile API returns the other user with avatar to the viewer', async () => {
    const res = await api<{ data?: { username?: string; displayName?: string; avatarUrl?: string | null; about?: string } }>(
      a,
      'GET',
      `/api/users/${b.username}`
    );
    assert.equal(res.status, 200, `GET profile: ${res.status}`);
    assert.equal(res.json.data?.username, b.username);
    assert.equal(res.json.data?.displayName, 'Target Account');
    assert.equal(res.json.data?.avatarUrl, avatarUrl, 'avatar not returned (privacy default is EVERYONE)');
  });

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
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const me = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: a.username, password: 'Passw0rd123' })
    });
    const cookie = /linkup_session=([^;]+)/.exec(me.headers.get('set-cookie') ?? '');
    assert.ok(cookie, 'no session cookie');
    await page.setCookie({ name: 'linkup_session', value: cookie![1], domain: 'localhost', path: '/' });

    // ── Mobile: the exact production repro.
    await page.goto(`${SERVER_URL}/app/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await waitFor('conversation', async () => await page.evaluate(() => document.body.innerText.includes('Target Account')));
    await tapViewProfile(page, 'Target Account');

    await check('mobile: View Profile navigates and the profile pane is visible', async () => {
      await waitFor('profile url', async () => (await page.url()).includes(`/app/u/${b.username}`));
      const state = await waitFor('profile pane visible', async () => {
        const s = await profileState(page);
        return s.mainWidth >= 300 ? s : false;
      });
      assert.ok(state.url.includes(`/app/u/${b.username}`), `url=${state.url}`);
      assert.ok(state.mainWidth >= 300, `main pane collapsed to ${state.mainWidth}px`);
    });

    await check('mobile: display name, username and About render', async () => {
      const s = await profileState(page);
      assert.ok(s.text.includes('Target Account'), 'display name missing');
      assert.ok(s.text.includes(`@${b.username}`), 'username missing');
      assert.ok(/about/i.test(s.text), 'About section missing');
    });

    await check('mobile: the profile picture renders', async () => {
      const s = await waitFor('avatar image', async () => {
        const x = await profileState(page);
        return x.avatarRendered ? x : false;
      });
      assert.ok(s.avatarRendered, 'avatar image not rendered');
    });

    await check('back navigation returns to the conversation', async () => {
      await page.evaluate(() => {
        const b = document.querySelector('[aria-label="Go back"]') as HTMLElement | null;
        b!.click();
      });
      await waitFor('conversation again', async () => {
        const u = page.url();
        return u.includes(`/app/chats/${convId}`) ? true : false;
      });
    });

    // ── Desktop must keep working.
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${SERVER_URL}/app/chats/${convId}`, { waitUntil: 'domcontentloaded' });
    await waitFor('conversation (desktop)', async () => await page.evaluate(() => document.body.innerText.includes('Target Account')));
    await tapViewProfile(page, 'Target Account');
    await check('desktop: profile renders with sidebar and main side by side', async () => {
      await waitFor('profile url (desktop)', async () => (await page.url()).includes(`/app/u/${b.username}`));
      const s = await waitFor('profile pane visible (desktop)', async () => {
        const x = await profileState(page);
        return x.mainWidth >= 300 ? x : false;
      });
      assert.ok(s.text.includes('Target Account'), 'display name missing');
      assert.ok(s.text.includes(`@${b.username}`), 'username missing');
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
