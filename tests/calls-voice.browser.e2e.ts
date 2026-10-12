/**
 * Phase 4B — REAL browser voice-call E2E (fake microphone devices).
 *
 * Two headless Chromium pages sign in as alex and emma, place a REAL WebRTC
 * voice call through the actual UI + signaling path, and the test verifies
 * genuine media transport: inbound-rtp AUDIO `bytesReceived > 0` on BOTH
 * sides (Chromium's fake audio device emits a tone, so real RTP audio packets
 * flow peer-to-peer between the two browsers).
 *
 * This is a REAL media-flow test (not mock WebRTC) — the audio SOURCES are
 * Chromium's fake devices, so it does not speak to human mic hardware.
 *
 * Requirements: a Chromium-based browser (auto-detected, or CHROMIUM_PATH)
 * + `npm i` (puppeteer-core is a devDependency). If none is installed the
 * suite exits BLOCKED (77) with setup instructions — it is not a pass.
 * Server must be running (SERVER_URL, default :3300).
 *
 * Run: npm run test:calls:browser
 */
import assert from 'node:assert/strict';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { exitOnBrowserBlocked, requireChromiumExecutable } from './chromium';

const BASE = process.env.SERVER_URL ?? 'http://localhost:3300';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Sign in via the REST API and inject the session cookie (deterministic —
 *  no UI click races). The call buttons themselves are clicked for real. */
async function loginViaApi(page: Page, username: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password: 'linkup123' })
  });
  assert.ok(res.ok, `login failed for ${username}: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /linkup_session=([^;]+)/.exec(setCookie);
  assert.ok(match, `no session cookie for ${username}`);
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' }); // anchor the origin
  await page.setCookie({ name: 'linkup_session', value: match![1], url: BASE });
  await page.goto(`${BASE}/app/chats`, { waitUntil: 'networkidle2' });
  const me = await page.evaluate(async () => {
    const r = await fetch('/api/auth/me');
    return { status: r.status, path: location.pathname };
  });
  assert.equal(me.status, 200, `session not active for ${username} (at ${me.path})`);
}

/** Real CDP mouse click on an element's center (carries user activation,
 *  avoids ElementHandle.click's evaluate-based scroll fallback). */
async function realClick(page: Page, selector: string) {
  const el = await page.waitForSelector(selector, { timeout: 10000 });
  const box = await el!.boundingBox();
  assert.ok(box, `no bounding box for ${selector}`);
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

interface AudioStats {
  inboundBytes: number;
  outboundBytes: number;
  inboundPackets: number;
}

async function readAudioStats(page: Page): Promise<AudioStats> {
  return page.evaluate(async () => {
    const hook = (window as unknown as { __LINKUP_CALL__?: { getStats(): Promise<Record<string, unknown>[]> } }).__LINKUP_CALL__;
    if (!hook) return { inboundBytes: 0, outboundBytes: 0, inboundPackets: 0 };
    const rows = await hook.getStats();
    let inboundBytes = 0;
    let outboundBytes = 0;
    let inboundPackets = 0;
    for (const s of rows) {
      const type = String(s.type);
      const kind = String(s.kind ?? s.mediaType ?? '');
      if (kind !== 'audio') continue;
      if (type === 'inbound-rtp') {
        inboundBytes += Number(s.bytesReceived ?? 0);
        inboundPackets += Number(s.packetsReceived ?? 0);
      } else if (type === 'outbound-rtp') {
        outboundBytes += Number(s.bytesSent ?? 0);
      }
    }
    return { inboundBytes, outboundBytes, inboundPackets };
  });
}

async function waitForAudioFlow(page: Page, label: string, timeoutMs = 20000): Promise<AudioStats> {
  const t0 = Date.now();
  let last: AudioStats = { inboundBytes: 0, outboundBytes: 0, inboundPackets: 0 };
  while (Date.now() - t0 < timeoutMs) {
    last = await readAudioStats(page);
    if (last.inboundBytes > 0) return last;
    await sleep(500);
  }
  throw new Error(`${label}: no inbound audio RTP after ${timeoutMs}ms (stats=${JSON.stringify(last)})`);
}

async function main() {
  const chromium = requireChromiumExecutable();

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: chromium,
      headless: true,
      protocolTimeout: 60_000,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--allow-insecure-localhost'
      ]
    });

    // Separate browser contexts so the two session cookies cannot overwrite
    // each other (one cookie jar per user).
    const aPage = await (await browser.createBrowserContext()).newPage();
    const ePage = await (await browser.createBrowserContext()).newPage();
    for (const p of [aPage, ePage]) {
      await p.setViewport({ width: 1280, height: 900 });
      p.on('pageerror', (err: unknown) => console.log('  [pageerror]', String(err)));
    }

    await loginViaApi(aPage, 'alex');
    await loginViaApi(ePage, 'emma');
    await sleep(500);

    const convDebug = await aPage.evaluate(async () => {
      const res = await fetch('/api/conversations', { headers: { 'Content-Type': 'application/json' } });
      const json = await res.json();
      const items = json.data?.conversations ?? json.data ?? [];
      const conv = (Array.isArray(items) ? items : []).find(
        (c: { type?: string; peer?: { username?: string } }) =>
          String(c.type) === 'DIRECT' && c.peer?.username === 'emma'
      );
      return {
        id: conv?.id ?? null,
        status: res.status,
        count: Array.isArray(items) ? items.length : -1,
        sample: Array.isArray(items)
          ? items.slice(0, 8).map((c: { type?: string; peer?: { username?: string }; title?: string }) => `${c.type}:${c.peer?.username ?? c.title ?? '?'}`)
          : String(items).slice(0, 100)
      };
    });
    const convId = convDebug.id;
    if (!convId) console.log('  [conv-debug]', JSON.stringify(convDebug));
    assert.ok(convId, 'alex↔emma conversation not found');

    await aPage.goto(`${BASE}/app/chats/${convId}`, { waitUntil: 'networkidle2' });
    await aPage.waitForSelector('[aria-label="Message input"]', { timeout: 15000 });

    // ── place the call through the real UI ──
    await realClick(aPage, '[aria-label="Start voice call"]');
    await aPage.waitForSelector('[role="dialog"][aria-label="Ongoing call"]', { timeout: 5000 });
    await ePage.waitForSelector('[role="dialog"][aria-label="Incoming call"]', { timeout: 10000 });
    await check('caller shows the ringing overlay and the callee receives the incoming call', () => {});

    await realClick(ePage, '[aria-label="Accept call"]');
    await aPage.waitForFunction(
      () => /call · /.test(document.querySelector('[data-testid="call-status"]')?.textContent ?? ''),
      { timeout: 10000 }
    );
    await check('accept connects the call (state CONNECTED on the caller)', () => {});

    // ── REAL media verification: audio RTP flowing both ways ──
    const aStats = await waitForAudioFlow(aPage, 'caller');
    const eStats = await waitForAudioFlow(ePage, 'callee');
    await check('REAL audio connectivity: caller received inbound audio RTP', () => {
      assert.ok(aStats.inboundBytes > 0, `bytes=${aStats.inboundBytes} packets=${aStats.inboundPackets}`);
    });
    await check('REAL audio connectivity: callee received inbound audio RTP', () => {
      assert.ok(eStats.inboundBytes > 0, `bytes=${eStats.inboundBytes} packets=${eStats.inboundPackets}`);
    });
    await check('both sides are SENDING audio RTP', () => {
      assert.ok(aStats.outboundBytes > 0 && eStats.outboundBytes > 0, `a=${aStats.outboundBytes} e=${eStats.outboundBytes}`);
    });

    await check('remote audio stream is attached and live on both sides', async () => {
      for (const [label, page] of [['caller', aPage], ['callee', ePage]] as const) {
        const info = await page.evaluate(() => {
          const hook = (window as unknown as { __LINKUP_CALL__?: { getRemoteStream(): MediaStream | null } }).__LINKUP_CALL__;
          const s = hook?.getRemoteStream() ?? null;
          const tracks = s?.getAudioTracks() ?? [];
          return { count: tracks.length, states: tracks.map((t) => t.readyState) };
        });
        assert.equal(info.count, 1, `${label}: remote audio tracks=${info.count}`);
        assert.ok(info.states.every((st) => st === 'live'), `${label}: track states=${info.states.join(',')}`);
      }
    });

    await check('engine applied the server-provided ICE configuration (Phase 4E)', async () => {
      for (const [label, page] of [['caller', aPage], ['callee', ePage]] as const) {
        const out = (await page.evaluate(async () => {
          const hook = (window as unknown as {
            __LINKUP_CALL__?: { getDiagnostics(): Record<string, unknown> | null };
          }).__LINKUP_CALL__;
          const d = hook?.getDiagnostics() ?? null;
          const res = await fetch('/api/calls/ice', { credentials: 'include' });
          const body = (await res.json()) as { data?: { iceServers?: unknown[] } };
          return { d, count: body.data?.iceServers?.length ?? 0 };
        })) as { d: Record<string, unknown> | null; count: number };
        assert.ok(out.d, `${label}: diagnostics hook available`);
        const d = out.d!;
        assert.equal(d.iceServerCount, out.count, `${label}: engine used the server-delivered ICE servers`);
        assert.ok(Number(d.iceServerCount) >= 1, `${label}: ICE config applied`);
        assert.ok(
          d.iceConnectionState === 'connected' || d.iceConnectionState === 'completed',
          `${label}: ICE connected (${String(d.iceConnectionState)})`
        );
        assert.equal(d.connectionState, 'connected', `${label}: pc connected`);
      }
    });

    // ── mute/unmute while connected ──
    await realClick(aPage, '[aria-label="Mute microphone"]');
    await sleep(300);
    await check('mute disables the local audio track and keeps the call connected', async () => {
      const info = await aPage.evaluate(() => {
        const hook = (window as unknown as { __LINKUP_CALL__?: { getLocalStream(): MediaStream | null } }).__LINKUP_CALL__;
        const t = hook?.getLocalStream()?.getAudioTracks()[0] ?? null;
        return { enabled: t?.enabled ?? null, status: document.querySelector('[data-testid="call-status"]')?.textContent ?? '' };
      });
      assert.equal(info.enabled, false, `track.enabled=${info.enabled}`);
      assert.ok(/call · /.test(info.status), `status=${info.status}`);
    });
    await check('unmute restores the local audio track', async () => {
      await realClick(aPage, '[aria-label="Unmute microphone"]');
      await sleep(300);
      const enabled = await aPage.evaluate(() => {
        const hook = (window as unknown as { __LINKUP_CALL__?: { getLocalStream(): MediaStream | null } }).__LINKUP_CALL__;
        return hook?.getLocalStream()?.getAudioTracks()[0]?.enabled ?? null;
      });
      assert.equal(enabled, true);
    });

    // ── end the call → full cleanup, microphone released ──
    await realClick(aPage, '[aria-label="End call"]');
    await sleep(700);
    await check('ending the call closes the overlay on both sides', async () => {
      for (const [label, page] of [['caller', aPage], ['callee', ePage]] as const) {
        const open = await page.$('[role="dialog"][aria-label="Ongoing call"], [role="dialog"][aria-label="Incoming call"]');
        assert.equal(open, null, `${label}: overlay still open`);
      }
    });
    await check('microphone is released after the call ends (no live local tracks)', async () => {
      for (const [label, page] of [['caller', aPage], ['callee', ePage]] as const) {
        const info = await page.evaluate(() => {
          const hook = (window as unknown as { __LINKUP_CALL__?: { getLocalStream(): MediaStream | null } }).__LINKUP_CALL__;
          const s = hook?.getLocalStream() ?? null;
          return {
            hasStream: !!s,
            liveTracks: s ? s.getTracks().filter((t) => t.readyState === 'live').length : 0
          };
        });
        assert.equal(info.hasStream, false, `${label}: local stream still held`);
        assert.equal(info.liveTracks, 0, `${label}: live tracks=${info.liveTracks}`);
      }
    });
    await check('remote streams are detached after the call ends', async () => {
      for (const [label, page] of [['caller', aPage], ['callee', ePage]] as const) {
        const has = await page.evaluate(() => {
          const hook = (window as unknown as { __LINKUP_CALL__?: { getRemoteStream(): MediaStream | null } }).__LINKUP_CALL__;
          return !!hook?.getRemoteStream();
        });
        assert.equal(has, false, `${label}: remote stream still held`);
      }
    });
  } finally {
    await browser?.close();
  }
}

main()
  .then(() => {
    console.log('\n════════════════════════════════════');
    console.log(`PASSED ${passed}  FAILED ${failed}`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    if (exitOnBrowserBlocked(err)) return;
    console.error('Fatal:', err);
    process.exit(1);
  });
