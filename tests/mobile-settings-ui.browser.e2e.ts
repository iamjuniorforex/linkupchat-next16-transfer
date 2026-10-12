/**
 * Mobile settings navigation (real browser, mobile viewport).
 *
 * Regression test for the phone-only bug where tapping Settings in the bottom
 * navigation appeared to "do nothing": the route changed to /app/settings, but
 * the sidebar's w-full flex-basis collapsed the content pane to 0px, leaving
 * the settings form laid out off-viewport. Asserting location.pathname alone
 * does NOT catch this — these checks assert the settings content is actually
 * within the mobile viewport and usable, plus a desktop two-column regression
 * check (sidebar AND main both visible).
 *
 * Also guards the toast/bottom-nav interaction: the mobile toast bar must stay
 * clear of the h-nav bar so it never swallows bottom-nav taps while visible,
 * while the dismiss button and the classic desktop bottom-right placement keep
 * working.
 *
 * Toast-phase design (hardened): every toast-dependent check triggers its OWN
 * production toast (real profile save → useToast success) and synchronizes
 * against the actual toast DOM (the ToastProvider portal: a direct <body>
 * child with aria-live="polite"). Nothing sleeps or assumes a shared 4s
 * auto-dismiss window. Bottom-nav taps are scoped to the production BottomNav
 * (nav[aria-label="Primary"]) — never a document-wide label match — and carry
 * full pointer instrumentation (elementFromPoint chain, fixed-overlay sweep,
 * touch/click event trace) so a failing environment names the actual element
 * receiving the pointer instead of timing out opaquely. If the tap point is
 * captured by the Next.js DEV overlay (<nextjs-portal> shadow host — dev-only
 * react-dev-overlay error toast), the check fails fast with the exact cause
 * and the environment remedy (run against the production server).
 *
 * Run: npm run test:mobile-settings:browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';
const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'mobile-settings-ui.browser.e2e.impl.log');
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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  display: string;
  visibility: string;
}

async function boxOf(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return { x: r.x, y: r.y, w: r.width, h: r.height, display: st.display, visibility: st.visibility };
  }, selector);
}

/** The bug being guarded: content rendered but laid out OUTSIDE the viewport. */
function assertInViewport(box: Box | null, viewport: { width: number; height: number }, label: string) {
  assert.ok(box, `${label}: element not found`);
  assert.equal(box!.display !== 'none' && box!.visibility !== 'hidden', true, `${label}: not visible`);
  assert.ok(box!.w > 0 && box!.h > 0, `${label}: zero-sized (${box!.w}x${box!.h})`);
  assert.ok(box!.x >= -0.5, `${label}: left edge off-screen (x=${box!.x})`);
  assert.ok(box!.y >= -0.5, `${label}: top edge off-screen (y=${box!.y})`);
  assert.ok(box!.x + box!.w <= viewport.width + 0.5, `${label}: right edge off-screen (x+w=${box!.x + box!.w} > ${viewport.width})`);
  assert.ok(box!.y + box!.h <= viewport.height + 100, `${label}: bottom edge off-screen (y+h=${box!.y + box!.h})`);
}

const bodyHas = async (page: Page, text: string) =>
  page.evaluate((t) => document.body.innerText.includes(t), text);

/* ── Production toast DOM (src/components/ui/Toast.tsx) ────────────────────
 * The ToastProvider portal renders as a DIRECT child of <body>:
 *   <div aria-live="polite" …>  ← container (positioned by the CSS fix)
 *     <div …> … <button aria-label="Dismiss notification">  ← toast item
 */
const TOAST_CONTAINER = 'body > div[aria-live="polite"]';
const DISMISS_BTN = `${TOAST_CONTAINER} [aria-label="Dismiss notification"]`;

/** Box of the live toast container that carries `title`, or null. */
async function toastBox(page: Page, title = 'Profile updated'): Promise<Box | null> {
  return page.evaluate(
    ({ sel, t }) => {
      const el = Array.from(document.querySelectorAll(sel)).find((n) => (n.textContent ?? '').includes(t));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return { x: r.x, y: r.y, w: r.width, h: r.height, display: st.display, visibility: st.visibility };
    },
    { sel: TOAST_CONTAINER, t: title }
  );
}

/** Observe the actual visible production toast (never a sleep). */
async function waitForToast(page: Page, title = 'Profile updated'): Promise<Box> {
  return waitFor(`toast "${title}"`, async () => {
    const b = await toastBox(page, title);
    return b && b.h > 0 && b.display !== 'none' && b.visibility !== 'hidden' ? b : null;
  }, 8000);
}

async function toastCount(page: Page): Promise<number> {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, DISMISS_BTN);
}

/** Deterministically clear any stale toasts through the production dismiss button. */
async function clearToasts(page: Page) {
  for (let i = 0; i < 4; i++) {
    const before = await toastCount(page);
    if (before === 0) return;
    await page.click(DISMISS_BTN);
    await waitFor('stale toast to dismiss', async () => (await toastCount(page)) < before, 3000);
  }
}

/** Real keyboard edit of the display name (React state updates on keystrokes). */
async function setDisplayName(page: Page, value: string) {
  await page.waitForSelector('[data-testid="profile-display-name"]', { visible: true });
  await page.click('[data-testid="profile-display-name"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value);
}

/**
 * Deterministic production toast: clear stale ones, then the real profile-save
 * success flow (useToast → 'Profile updated'), observed on the real toast DOM.
 */
async function triggerToast(page: Page, displayName: string) {
  await clearToasts(page);
  await setDisplayName(page, displayName);
  await page.click('[data-testid="profile-save"]');
  await waitForToast(page, 'Profile updated');
}

/* ── Pointer instrumentation ──────────────────────────────────────────────
 * Every BottomNav tap records what ACTUALLY receives the pointer at the tap
 * coordinates (elementFromPoint chain with computed pointer-events/z-index,
 * the full position:fixed overlay sweep, and a capture-phase event trace of
 * touchstart/touchend/mousedown/mouseup/click with targets). Evidence is
 * written to the impl log so a failing environment shows the real interceptor
 * instead of a bare timeout. Tap activation: a real touch at the visually
 * verified coordinates; if the browser drops the touch→click synthesis (trace
 * proves touchstart/touchend landed, no click, no app preventDefault) one
 * coordinate mouse click seeds the identical `click` event a real tap
 * synthesizes. If app code cancel()s the touch (defaultPrevented=true) there
 * is NO fallback — that is a production tap block and must fail.
 */
interface TapEvidence {
  chain: string[];
  fixed: string[];
  trace: { type: string; target: string; inPrimaryNav: boolean; x: number; y: number }[];
  urlBefore: string;
  urlAfter: string;
  usedFallback: boolean;
}

async function pointerEvidence(page: Page, x: number, y: number): Promise<{ chain: string[]; fixed: string[] }> {
  // NOTE: callbacks passed to page.evaluate must use only ANONYMOUS inline
  // functions — tsx/esbuild keepNames wraps named bindings with a module-scope
  // `__name` helper that does not exist in the browser context.
  return page.evaluate(
    ({ x, y }) => {
      return {
        chain: document.elementsFromPoint(x, y).map((el) => {
          const st = getComputedStyle(el);
          const aria = el.getAttribute('aria-label');
          return `${el.tagName}${aria ? `[${aria}]` : ''}.${(el.getAttribute('class') ?? '').slice(0, 48)} pe=${st.pointerEvents} z=${st.zIndex} ${st.position}`;
        }),
        fixed: Array.from(document.querySelectorAll('body *'))
          .filter((el) => getComputedStyle(el).position === 'fixed')
          .map((el) => {
            const st = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return `${el.tagName}[${el.getAttribute('aria-label') ?? ''}].${(el.getAttribute('class') ?? '').slice(0, 48)} pe=${st.pointerEvents} z=${st.zIndex} ${st.position} [${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}]`;
          })
      };
    },
    { x, y }
  );
}

async function installTapTrace(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __tapTrace?: unknown[] };
    if (w.__tapTrace) {
      w.__tapTrace.length = 0;
      return;
    }
    w.__tapTrace = [];
    for (const type of ['touchstart', 'touchend', 'mousedown', 'mouseup', 'click']) {
      document.addEventListener(
        type,
        (e) => {
          const t = e.target as Element | null;
          const pos = (e as unknown as { touches?: { clientX: number; clientY: number }[]; changedTouches?: { clientX: number; clientY: number }[] }) ;
          const p = pos.touches?.[0] ?? pos.changedTouches?.[0] ?? (e as unknown as { clientX: number; clientY: number });
          w.__tapTrace!.push({
            type,
            target: t ? `${t.tagName}[${t.getAttribute('aria-label') || (t.textContent || '').trim().slice(0, 12)}]` : 'null',
            inPrimaryNav: !!(t && t.closest && t.closest('nav[aria-label="Primary"]')),
            x: Math.round(p.clientX ?? -1),
            y: Math.round(p.clientY ?? -1)
          });
          if (type === 'touchstart' || type === 'touchend') {
            const ev = e;
            setTimeout(() => {
              w.__tapTrace!.push({ type: `${type}#defaultPrevented=${ev.defaultPrevented}`, target: '', inPrimaryNav: false, x: -1, y: -1 });
            }, 0);
          }
        },
        true
      );
    }
  });
}

async function readTapTrace(page: Page): Promise<TapEvidence['trace']> {
  return page.evaluate(() => ((window as unknown as { __tapTrace?: unknown[] }).__tapTrace ?? []) as never);
}

/**
 * Tap a production BottomNav item at visually verified coordinates and prove
 * the pointer reached it: elementFromPoint must resolve INSIDE the link, the
 * toast (if expected) must be visible at the tap moment, and a click event
 * must land inside the BottomNav. Evidence goes to the impl log either way.
 */
async function tapBottomNav(page: Page, label: string, opts: { expectToast?: boolean } = {}): Promise<TapEvidence> {
  const info = await page.evaluate((lbl: string) => {
    const links = Array.from(document.querySelectorAll('nav[aria-label="Primary"] a'));
    const a = links.find((el) => (el.textContent ?? '').trim() === lbl) as HTMLElement | undefined;
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }, label);
  assert.ok(info, `bottom-nav link "${label}" not found`);
  assert.ok(info!.rect.w > 0 && info!.rect.h > 0, `bottom-nav link "${label}" zero-sized`);
  const { cx, cy } = info!;

  // What ACTUALLY receives the pointer at the tap coordinates?
  const reach = await page.evaluate(
    ({ x, y, lbl }) => {
      const top = document.elementFromPoint(x, y);
      const link = top ? (top.closest('nav[aria-label="Primary"] a') as HTMLElement | null) : null;
      return {
        top: top ? `${top.tagName}[${top.getAttribute('aria-label') || (top.textContent || '').trim().slice(0, 12)}]` : 'null',
        devOverlay: !!top && (top.tagName === 'NEXTJS-PORTAL' || !!top.closest('nextjs-portal')),
        reachesLink: !!link && (link.textContent ?? '').trim() === lbl
      };
    },
    { x: cx, y: cy, lbl: label }
  );
  const evidence = await pointerEvidence(page, cx, cy);
  if (reach.devOverlay) {
    // Environment artifact, not app UI: <nextjs-portal> is the shadow-DOM host
    // of Next.js's react-dev-overlay (dev-only; production bundles contain zero
    // nextjs-portal code). Its "… error" toast (fixed, z-9000, bottom-left)
    // covers the Chats tab whenever a client-side error has occurred — e.g. the
    // ToastProvider hydration mismatch (SSR emits no portal div; the client's
    // first render does). Run this suite against the production server.
    throw new Error(
      `Next.js DEV overlay is intercepting taps at (${cx},${cy}): top receiver is the <nextjs-portal> shadow host of ` +
        `react-dev-overlay (error toast, fixed z-9000, bottom-left) — dev-only tooling, absent from production builds. ` +
        `It appears because a client-side error occurred (see the [pageerror] lines in the impl log; the known trigger is ` +
        `the ToastProvider hydration mismatch). Fix the ENVIRONMENT: run the regression against the production server ` +
        `(npm run build + NODE_ENV=production, see README) instead of \`next dev\`. Hit chain: ${evidence.chain.join(' | ')}`
    );
  }
  const toastBefore = opts.expectToast ? await toastBox(page) : null;
  if (opts.expectToast) {
    assert.ok(toastBefore && toastBefore.h > 0, `toast not visible immediately before tapping "${label}"`);
  }
  assert.ok(
    reach.reachesLink,
    `pointer at (${cx},${cy}) does not reach BottomNav "${label}" — top receiver: ${reach.top}; chain: ${evidence.chain.join(' | ')}; fixed: ${evidence.fixed.join(' | ')}`
  );

  await installTapTrace(page);
  const urlBefore = page.url();
  await page.touchscreen.tap(cx, cy);
  await waitFor('tap events to dispatch', async () => (await readTapTrace(page)).length >= 2, 1200).catch(() => false);
  const toastAfterTap = opts.expectToast ? await toastBox(page) : null;
  if (opts.expectToast) {
    assert.ok(toastAfterTap && toastAfterTap.h > 0, `toast not visible immediately after tapping "${label}"`);
  }

  let trace = await readTapTrace(page);
  const touchPrevented = trace.some((e) => e.type.includes('defaultPrevented=true'));
  const clickOnNav = () => trace.some((e) => e.type === 'click' && e.inPrimaryNav);
  let usedFallback = false;

  if (!clickOnNav()) {
    assert.ok(
      !touchPrevented,
      `app code cancel()ed the touch on BottomNav "${label}" (production tap block) — trace: ${JSON.stringify(trace)}`
    );
    const hasClick = trace.some((e) => e.type === 'click');
    if (!hasClick) {
      // The browser dropped the touch→click synthesis (trace proves the touch
      // landed with no preventDefault and no click): seed the identical click
      // event a real tap synthesizes, at the same verified coordinates.
      usedFallback = true;
      await page.mouse.click(cx, cy);
      await waitFor('click to land on the BottomNav', async () => {
        trace = await readTapTrace(page);
        return clickOnNav() || null;
      }, 1500).catch(() => false);
      trace = await readTapTrace(page);
    }
    assert.ok(
      clickOnNav(),
      `no click event reached BottomNav "${label}" — actual trace: ${JSON.stringify(trace)}; chain at tap point: ${evidence.chain.join(' | ')}`
    );
  }

  const urlAfter = (await sleep(300), page.url());
  ilog(
    `TAP ${label} (${cx},${cy}) urlBefore=${urlBefore} urlAfter=${urlAfter} fallback=${usedFallback} toast=${!!toastAfterTap}`
  );
  ilog(`  chain: ${evidence.chain.join(' | ')}`);
  ilog(`  fixed: ${evidence.fixed.join(' | ')}`);
  ilog(`  trace: ${JSON.stringify(trace)}`);
  return { ...evidence, trace, urlBefore, urlAfter, usedFallback };
}

/** Tap a BottomNav item and strictly require the route change (bounded retry). */
async function tapBottomNavUntil(page: Page, label: string, pathFragment: string, opts: { expectToast?: boolean } = {}) {
  const arrived = async () => (await page.url()).includes(pathFragment);
  await tapBottomNav(page, label, opts);
  const ok = await waitFor(`navigation to ${pathFragment} (attempt 1)`, arrived, 2500).catch(() => false);
  if (!ok) {
    await tapBottomNav(page, label, opts);
  }
  await waitFor(`navigation to ${pathFragment}`, arrived, 15000);
}

async function main() {
  requireChromiumExecutable();
  console.log('■ mobile-settings-ui.browser: Settings navigation at mobile viewport');
  const username = `msui_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = 'Passw0rd123';

  // Disposable account (register requires email or phone).
  const reg = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, displayName: 'Mobile Tester', email: `${username}@example.com` })
  });
  assert.ok(reg.ok, `register failed: ${reg.status} ${await reg.text()}`);

  // Session cookie for the browser (production login sets linkup_session).
  const loginRes = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, password })
  });
  assert.ok(loginRes.ok, `login failed: ${loginRes.status}`);
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const m = /linkup_session=([^;]+)/.exec(setCookie);
  assert.ok(m, 'no session cookie');
  const sessionCookie = { name: 'linkup_session', value: m![1], domain: 'localhost', path: '/' };

  const MOBILE = { width: 390, height: 844 };
  const DESKTOP = { width: 1280, height: 800 };
  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  const browser: Browser = await puppeteer.launch({
    executablePath: requireChromiumExecutable(),
    headless: true,
    protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });

  try {
    const page = await browser.newPage();
    // A beforeunload prompt must be ACCEPTED: dismissing it cancels the very
    // navigation under test (any leave-guard in a merged codebase would eat it).
    page.on('dialog', (d) => {
      ilog(`[dialog] ${d.type()}: ${d.message().slice(0, 80)}`);
      if (d.type() === 'beforeunload') void d.accept();
      else void d.dismiss();
    });
    page.on('pageerror', (e) => ilog(`[pageerror] ${String((e as Error)?.message ?? e)}`));

    // Phone emulation: mobile viewport + touch (this is where the bug lived).
    await page.setUserAgent(IPHONE_UA);
    await page.setViewport({ ...MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.setCookie(sessionCookie);

    // ── 1. Start from Chats, tap Settings in the bottom nav like a user would.
    await page.goto(`${SERVER_URL}/app/chats`, { waitUntil: 'domcontentloaded' });
    await waitFor('app shell', () => page.$('nav[aria-label="Primary"]'));
    await tapBottomNavUntil(page, 'Settings', '/app/settings');

    await check('mobile: tapping Settings in the bottom nav navigates to /app/settings', async () => {
      assert.ok((await page.url()).includes('/app/settings'), `url=${await page.url()}`);
    });

    // ── 2. The regression itself: the profile form must be WITHIN the mobile
    //       viewport (the bug rendered it off-viewport at x≈439 of a 390 screen).
    await waitFor('profile form', () => page.$('[data-testid="profile-save"]'));
    await check('mobile: settings content pane fills the viewport (no 0px collapse)', async () => {
      const mainBox = await boxOf(page, 'main');
      assert.ok(mainBox, 'no <main> element');
      assert.ok(mainBox!.w >= MOBILE.width - 4, `main width ${mainBox!.w}px collapsed (expected ≈${MOBILE.width}px)`);
    });

    await check('mobile: profile form fields are laid out within the viewport', async () => {
      assertInViewport(await boxOf(page, '[data-testid="profile-display-name"]'), MOBILE, 'display-name input');
      assertInViewport(await boxOf(page, '[data-testid="profile-username"]'), MOBILE, 'username input');
      assertInViewport(await boxOf(page, '[data-testid="profile-about"]'), MOBILE, 'about input');
    });

    await check('mobile: Save changes button is laid out within the viewport', async () => {
      assertInViewport(await boxOf(page, '[data-testid="profile-save"]'), MOBILE, 'profile-save');
    });

    // ── 3. The form must be usable at mobile width: real edit + save + toast.
    await check('mobile: editing profile and saving works at mobile width', async () => {
      await triggerToast(page, 'Mobile Tester 2');
      assert.ok(await bodyHas(page, 'Profile updated'), 'no success toast');
    });

    // ── 4. Toast + bottom-nav coexistence. Regression: the toast bar used to
    //       sit at bottom-4 (z-[200], pointer-events-auto) over the h-nav bar
    //       and swallow taps on the covered nav buttons. Each check below
    //       triggers its OWN production toast and acts inside its lifetime.
    await check('mobile: toast bar does not overlap the bottom navigation', async () => {
      await triggerToast(page, 'Toast Geometry');
      const toast = await waitForToast(page, 'Profile updated');
      const nav = await boxOf(page, 'nav[aria-label="Primary"]');
      assert.ok(nav, 'bottom nav not found');
      assert.ok(toast.h > 0, 'toast zero-sized');
      assert.ok(nav!.h > 0, 'bottom nav zero-sized');
      assert.ok(
        toast.y + toast.h <= nav!.y + 0.5,
        `toast overlaps bottom nav (toastBottom=${toast.y + toast.h}, navTop=${nav!.y})`
      );
    });

    await check('mobile: bottom navigation works while the toast is visible', async () => {
      await triggerToast(page, 'Toast Navigator');
      const before = await toastBox(page);
      assert.ok(before && before.h > 0, 'toast not visible at tap time');
      // The helper proves at each tap moment that the toast is visible and that
      // the pointer reaches the real BottomNav link; navigation stays strict.
      await tapBottomNavUntil(page, 'Chats', '/app/chats', { expectToast: true });
      assert.ok((await page.url()).includes('/app/chats'), `url=${await page.url()}`);
    });

    await check('mobile: toast dismiss button works', async () => {
      // Check 7 left us on /app/chats — return to the settings form via the
      // production BottomNav, then dismiss a fresh toast.
      await tapBottomNavUntil(page, 'Settings', '/app/settings');
      await triggerToast(page, 'Toast Dismissal');
      await waitForToast(page, 'Profile updated');
      await page.waitForSelector(DISMISS_BTN, { visible: true });
      await page.click(DISMISS_BTN);
      // The toast is <2s old here; auto-dismiss fires at 4s, so a disappearance
      // within this window can only come from the dismiss button.
      await waitFor('toast dismissal', async () => !(await bodyHas(page, 'Profile updated')), 2000);
      assert.ok(!(await bodyHas(page, 'Profile updated')), 'toast still visible after dismiss');
    });

    // ── 5. Desktop regression: sidebar AND main must both be visible.
    await page.setViewport({ ...DESKTOP, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
    await page.goto(`${SERVER_URL}/app/settings`, { waitUntil: 'domcontentloaded' });
    await waitFor('profile form (desktop)', () => page.$('[data-testid="profile-save"]'));

    await check('desktop: sidebar and main are both visible on /app/settings', async () => {
      const asideBox = await boxOf(page, 'aside');
      const mainBox = await boxOf(page, 'main');
      assert.ok(asideBox && asideBox.w > 100, `sidebar collapsed (${asideBox?.w}px)`);
      assert.ok(mainBox && mainBox.w > 400, `main collapsed (${mainBox?.w}px)`);
    });

    await check('desktop: Save changes button is laid out within the viewport', async () => {
      assertInViewport(await boxOf(page, '[data-testid="profile-save"]'), DESKTOP, 'profile-save (desktop)');
    });

    // ── 6. Desktop toast behavior is preserved: classic bottom-right placement.
    await check('desktop: toast shows at the bottom-right (existing placement)', async () => {
      await triggerToast(page, 'Desktop Placement');
      const toast = await waitForToast(page, 'Profile updated');
      const rightGap = DESKTOP.width - (toast.x + toast.w);
      const bottomGap = DESKTOP.height - (toast.y + toast.h);
      assert.ok(rightGap >= 12 && rightGap <= 36, `right gap ${rightGap}px (expected ≈24px)`);
      assert.ok(bottomGap >= 12 && bottomGap <= 36, `bottom gap ${bottomGap}px (expected ≈24px)`);
    });

    await check('desktop: toast dismiss button works', async () => {
      await triggerToast(page, 'Desktop Dismissal');
      await waitForToast(page, 'Profile updated');
      await page.waitForSelector(DISMISS_BTN, { visible: true });
      await page.click(DISMISS_BTN);
      await waitFor('desktop toast dismissal', async () => !(await bodyHas(page, 'Profile updated')), 2000);
      assert.ok(!(await bodyHas(page, 'Profile updated')), 'toast still visible after dismiss');
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
