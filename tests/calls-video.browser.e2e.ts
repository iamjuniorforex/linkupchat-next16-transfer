/**
 * Phase 4C — REAL 1-to-1 VIDEO calls between two browser sessions.
 *
 * REAL, not mocked: two Chromium browser contexts join the same conversation,
 * place a video call, and exchange genuine WebRTC video+audio RTP over
 * loopback. Chromium's fake camera produces real rolling-pattern video frames,
 * so video bytesReceived/framesDecoded > 0 proves actual encoded video flows
 * both ways. Also covers the camera toggle (microphone must keep flowing),
 * the remote camera-off placeholder, local preview, and full cleanup.
 *
 * Run: npm run test:calls:video-browser   (server must be running)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { requireChromiumExecutable, exitOnBrowserBlocked } from './chromium';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';
const ARTIFACTS = path.join(process.cwd(), 'test-results');
const IMPL_LOG = path.join(ARTIFACTS, 'calls-video.browser.e2e.impl.log');
const API_LOG = path.join(ARTIFACTS, 'calls-video.browser.e2e.api.log');
fs.mkdirSync(ARTIFACTS, { recursive: true });

let passed = 0;
let failed = 0;
const implLines: string[] = [];
const apiLines: string[] = [];

function ilog(line: string) {
  implLines.push(line);
  fs.writeFileSync(IMPL_LOG, implLines.join('\n') + '\n');
}
function alog(line: string) {
  apiLines.push(line);
  fs.writeFileSync(API_LOG, apiLines.join('\n') + '\n');
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

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30000,
  intervalMs = 250
): Promise<T> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for: ${label}${lastErr ? ` (${String(lastErr)})` : ''}`);
}

/** Sign in via the REST API and inject the session cookie (deterministic —
 *  no UI click races). The call buttons themselves are clicked for real. */
async function loginViaApi(page: Page, username: string) {
  const res = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password: 'linkup123' })
  });
  alog(`POST /api/auth/login ${username} -> ${res.status}`);
  assert.ok(res.ok, `login failed for ${username}: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /linkup_session=([^;]+)/.exec(setCookie);
  assert.ok(match, `no session cookie for ${username}`);
  await page.goto(`${SERVER_URL}/login`, { waitUntil: 'domcontentloaded' }); // anchor the origin
  await page.setCookie({ name: 'linkup_session', value: match![1], url: SERVER_URL });
  await page.goto(`${SERVER_URL}/app/chats`, { waitUntil: 'networkidle2' });
  const me = await page.evaluate(async () => {
    const r = await fetch('/api/auth/me');
    return { status: r.status, path: location.pathname };
  });
  alog(`GET /api/auth/me ${username} -> ${me.status}`);
  assert.equal(me.status, 200, `session not active for ${username} (at ${me.path})`);
}

/** Real CDP mouse click on an element's center (carries user activation). */
async function realClick(page: Page, selector: string) {
  const el = await page.waitForSelector(selector, { timeout: 20000 });
  const box = await el!.boundingBox();
  assert.ok(box, `no bounding box for ${selector}`);
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

async function findDirectConversation(page: Page, peerUsername: string): Promise<string> {
  const out = await page.evaluate(async (peer) => {
    const res = await fetch('/api/conversations', { headers: { 'Content-Type': 'application/json' } });
    const json = await res.json();
    const items = json.data?.conversations ?? json.data ?? [];
    const conv = (Array.isArray(items) ? items : []).find(
      (c: { type?: string; peer?: { username?: string } }) =>
        String(c.type) === 'DIRECT' && c.peer?.username === peer
    );
    return {
      id: conv?.id ?? null,
      status: res.status,
      sample: Array.isArray(items)
        ? items.slice(0, 8).map((c: { type?: string; peer?: { username?: string }; title?: string }) => `${c.type}:${c.peer?.username ?? c.title ?? '?'}`)
        : String(items).slice(0, 100)
    };
  }, peerUsername);
  alog(`GET /api/conversations find DIRECT with ${peerUsername} -> ${out.status} id=${out.id}`);
  if (!out.id) ilog(`[conv-debug] ${JSON.stringify(out)}`);
  assert.ok(out.id, `DIRECT conversation with ${peerUsername} not found`);
  return out.id as string;
}

async function openConversation(page: Page, convId: string) {
  await page.goto(`${SERVER_URL}/app/chats/${convId}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[aria-label="Start video call"]', { timeout: 30000 });
}

/** Aggregate inbound-rtp bytes/frames received per media kind. */
async function inboundBytes(page: Page) {
  return page.evaluate(async () => {
    const api = (window as unknown as { __LINKUP_CALL__?: { getStats(): Promise<Record<string, unknown>[]> } })
      .__LINKUP_CALL__;
    if (!api) return { audio: 0, video: 0, videoFrames: 0 };
    const stats = await api.getStats();
    let audio = 0;
    let video = 0;
    let videoFrames = 0;
    for (const s of stats) {
      const kind = String(s.kind ?? '');
      const type = String(s.type ?? '');
      if (type !== 'inbound-rtp') continue;
      const bytes = Number(s.bytesReceived ?? 0);
      const frames = Number(s.framesDecoded ?? 0);
      if (kind === 'audio') audio += bytes;
      if (kind === 'video') {
        video += bytes;
        videoFrames += frames;
      }
    }
    return { audio, video, videoFrames };
  });
}

async function localTrackState(page: Page) {
  return page.evaluate(() => {
    const api = (window as unknown as { __LINKUP_CALL__?: { getLocalStream(): MediaStream | null } }).__LINKUP_CALL__;
    const stream = api?.getLocalStream() ?? null;
    return {
      hasStream: !!stream,
      liveAudio: stream?.getAudioTracks().filter((t) => t.readyState === 'live').length ?? 0,
      liveVideo: stream?.getVideoTracks().filter((t) => t.readyState === 'live').length ?? 0
    };
  });
}

async function keepLocalStream(page: Page) {
  await page.evaluate(() => {
    const api = (window as unknown as { __LINKUP_CALL__?: { getLocalStream(): MediaStream | null } }).__LINKUP_CALL__;
    (window as unknown as { __keptLocal?: MediaStream | null }).__keptLocal = api?.getLocalStream() ?? null;
  });
}

async function keptTracksLive(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __keptLocal?: MediaStream | null }).__keptLocal ?? null;
    if (!s) return -1;
    return s.getTracks().filter((t) => t.readyState === 'live').length;
  });
}

const style = (page: Page, testid: string, prop: 'opacity' | 'visibility') =>
  page.evaluate(
    (id, p) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? getComputedStyle(el)[p as 'opacity' | 'visibility'] : null;
    },
    testid,
    prop
  );

const exists = (page: Page, testid: string) =>
  page.evaluate((id) => !!document.querySelector(`[data-testid="${id}"]`), testid);

async function main() {
  requireChromiumExecutable();
  console.log('■ calls-video.browser: REAL video calls (two browser sessions)');
  alog(`server=${SERVER_URL}`);
  const USER_A = 'alex';
  const USER_B = 'emma';

  const browser: Browser = await puppeteer.launch({
    executablePath: requireChromiumExecutable(),
    headless: true,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });

  /** Phase 4E: record ICE-config fetches made by the call flow. */
  const iceRequests: string[] = [];

  // One browser context PER user — a shared context shares one cookie jar.
  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  for (const [label, page] of [
    ['A', pageA],
    ['B', pageB]
  ] as const) {
    page.on('dialog', (d) => void d.dismiss());
    page.on('pageerror', (e) => ilog(`[page${label}][error] ${String((e as Error)?.message ?? e)}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) ilog(`[page${label}][console.error] ${m.text()}`);
    });
    page.on('request', (r) => {
      if (r.url().includes('/api/calls/ice')) iceRequests.push(`${label}:${r.url()}`);
    });
  }

  try {
    await loginViaApi(pageA, USER_A);
    await loginViaApi(pageB, USER_B);
    await sleep(500);

    await check('setup: both users open their shared DIRECT conversation', async () => {
      const convId = await findDirectConversation(pageA, USER_B);
      (globalThis as Record<string, unknown>).__convId = convId;
      await openConversation(pageA, convId);
      await openConversation(pageB, convId);
    });
    const convId = (globalThis as Record<string, unknown>).__convId as string;

    await check('caller starts a video call → both sides show the video call UI', async () => {
      await realClick(pageA, '[aria-label="Start video call"]');
      await pageA.waitForSelector('[role="dialog"][aria-label="Ongoing call"]', { timeout: 15000 });
      await pageB.waitForSelector('[role="dialog"][aria-label="Incoming call"]', { timeout: 15000 });
      const hasAccept = await pageB.$('[aria-label="Accept call"]');
      assert.ok(hasAccept, 'accept button rendered');
    });

    await check('callee accepts → both connect and BOTH local previews show live camera video', async () => {
      await realClick(pageB, '[aria-label="Accept call"]');
      await waitFor('caller shows live remote video', async () => (await style(pageA, 'remote-video', 'opacity')) === '1');
      await waitFor('callee shows live remote video', async () => (await style(pageB, 'remote-video', 'opacity')) === '1');
      await waitFor('caller call-status appears', async () => await exists(pageA, 'call-status'));
      for (const page of [pageA, pageB]) {
        const t = await localTrackState(page);
        assert.equal(t.liveVideo, 1, 'live local video track');
        assert.equal(t.liveAudio, 1, 'live local audio track');
        assert.equal(await style(page, 'local-video', 'visibility'), 'visible', 'local preview visible');
        assert.equal(await exists(page, 'camera-off-placeholder'), false);
      }
    });

    await check('REAL video RTP flows both ways (bytes + decoded frames)', async () => {
      const [a, b] = await Promise.all([
        waitFor(
          'caller receives video',
          async () => {
            const s = await inboundBytes(pageA);
            return s.video > 0 && s.videoFrames > 0 ? s : null;
          },
          30000
        ),
        waitFor(
          'callee receives video',
          async () => {
            const s = await inboundBytes(pageB);
            return s.video > 0 && s.videoFrames > 0 ? s : null;
          },
          30000
        )
      ]);
      assert.ok(a.video > 0, `caller received video bytes: ${a.video}`);
      assert.ok(b.video > 0, `callee received video bytes: ${b.video}`);
      assert.ok(a.videoFrames > 0, `caller decoded video frames: ${a.videoFrames}`);
      assert.ok(b.videoFrames > 0, `callee decoded video frames: ${b.videoFrames}`);
    });

    await check('REAL audio RTP also flows both ways on the video call', async () => {
      const [a, b] = await Promise.all([
        waitFor('caller receives audio', async () => ((await inboundBytes(pageA)).audio > 0 ? true : null)),
        waitFor('callee receives audio', async () => ((await inboundBytes(pageB)).audio > 0 ? true : null))
      ]);
      assert.ok(a && b);
    });

    await check('engine accepts and applies the server-provided ICE configuration (Phase 4E)', async () => {
      assert.ok(
        iceRequests.some((u) => u.includes('/api/calls/ice')),
        `call flow fetched /api/calls/ice (${iceRequests.join(',') || 'none'})`
      );
      for (const page of [pageA, pageB]) {
        const out = (await page.evaluate(async () => {
          const api = (window as unknown as {
            __LINKUP_CALL__?: { getDiagnostics(): Record<string, unknown> | null };
          }).__LINKUP_CALL__;
          const d = api?.getDiagnostics() ?? null;
          const res = await fetch('/api/calls/ice', { credentials: 'include' });
          const body = (await res.json()) as { data?: { iceServers?: unknown[] } };
          return { d, count: body.data?.iceServers?.length ?? 0 };
        })) as { d: Record<string, unknown> | null; count: number };
        assert.ok(out.d, 'diagnostics hook available');
        const d = out.d!;
        assert.equal(d.iceServerCount, out.count, 'engine was built with the server-delivered ICE servers');
        assert.ok(Number(d.iceServerCount) >= 1, 'ICE config applied');
        assert.ok(
          d.iceGatheringState === 'gathering' || d.iceGatheringState === 'complete',
          `gathering state tracked (${String(d.iceGatheringState)})`
        );
        assert.ok(
          d.iceConnectionState === 'connected' || d.iceConnectionState === 'completed',
          `ICE connected (${String(d.iceConnectionState)})`
        );
        assert.equal(d.connectionState, 'connected');
        const flat = JSON.stringify(d);
        for (const secret of ['credential', 'username', 'stun:', 'turn:']) {
          assert.ok(!flat.includes(secret), `diagnostics leaked ${secret}`);
        }
      }
    });

    await check('camera OFF: local placeholder on caller + remote camera-off shown on callee', async () => {
      await realClick(pageA, '[aria-label="Turn camera off"]');
      await waitFor('caller placeholder', async () => await exists(pageA, 'camera-off-placeholder'));
      assert.equal(await style(pageA, 'local-video', 'visibility'), 'hidden', 'local preview hidden');
      await waitFor('callee sees remote-camera-off', async () => await exists(pageB, 'remote-camera-off'));
      await waitFor('remote video hidden on callee', async () => (await style(pageB, 'remote-video', 'opacity')) === '0');
      const t = await localTrackState(pageA);
      assert.equal(t.liveVideo, 0, 'caller video track is stopped');
      assert.equal(t.liveAudio, 1, 'caller mic still live');
    });

    await check('voice audio CONTINUES while the camera is off', async () => {
      const before = await inboundBytes(pageB);
      await sleep(3000);
      const after = await inboundBytes(pageB);
      assert.ok(after.audio > before.audio, `audio kept flowing (callee) ${before.audio} -> ${after.audio}`);
      const beforeA = await inboundBytes(pageA);
      await sleep(2000);
      const afterA = await inboundBytes(pageA);
      assert.ok(afterA.audio > beforeA.audio, `audio kept flowing (caller) ${beforeA.audio} -> ${afterA.audio}`);
    });

    await check('camera ON again: preview returns and the peer sees video again', async () => {
      await realClick(pageA, '[aria-label="Turn camera on"]');
      await waitFor('caller placeholder gone', async () => !(await exists(pageA, 'camera-off-placeholder')));
      await waitFor('callee remote-camera-off gone', async () => !(await exists(pageB, 'remote-camera-off')));
      await waitFor('callee remote video visible again', async () => (await style(pageB, 'remote-video', 'opacity')) === '1');
      const before = await inboundBytes(pageB);
      await waitFor(
        'fresh video RTP after re-enable',
        async () => {
          const s = await inboundBytes(pageB);
          return s.video > before.video ? s : null;
        },
        20000
      );
      const t = await localTrackState(pageA);
      assert.equal(t.liveVideo, 1, 'caller video recaptured');
    });

    await check('camera toggle works in BOTH directions (callee off → caller sees it)', async () => {
      await realClick(pageB, '[aria-label="Turn camera off"]');
      await waitFor('caller sees remote-camera-off', async () => await exists(pageA, 'remote-camera-off'));
      await realClick(pageB, '[aria-label="Turn camera on"]');
      await waitFor('caller sees video again', async () => !(await exists(pageA, 'remote-camera-off')));
    });

    await check('ending the call tears everything down (no live tracks, overlay gone)', async () => {
      await keepLocalStream(pageA);
      await keepLocalStream(pageB);
      await realClick(pageA, '[aria-label="End call"]');
      await waitFor('caller overlay closed', async () => !(await exists(pageA, 'call-status')));
      await waitFor('callee overlay closed', async () => !(await exists(pageB, 'call-status')));
      await sleep(500);
      assert.equal(await keptTracksLive(pageA), 0, 'caller: all local tracks stopped');
      assert.equal(await keptTracksLive(pageB), 0, 'callee: all local tracks stopped');
    });

    await check('the completed VIDEO call is recorded in history', async () => {
      const rows = await pageA.evaluate(async () => {
        const r = await fetch('/api/calls');
        return { status: r.status, body: await r.text() };
      });
      alog(`GET /api/calls -> ${rows.status}`);
      assert.equal(rows.status, 200);
      const parsed = JSON.parse(rows.body) as Record<string, unknown>;
      const payload = (parsed.data ?? parsed) as Record<string, unknown>;
      const list = (Array.isArray(payload.calls) ? payload.calls : Array.isArray(parsed) ? parsed : []) as {
        direction: string;
        callKind?: string;
        type?: string;
        peer?: { username?: string };
      }[];
      const videoCall = list.find(
        (c) => (c.callKind ?? c.type) === 'VIDEO' && c.direction === 'OUTGOING' && c.peer?.username === USER_B
      );
      assert.ok(videoCall, `expected an OUTGOING VIDEO call to ${USER_B} in ${JSON.stringify(list).slice(0, 300)}`);
      void convId;
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
