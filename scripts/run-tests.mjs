#!/usr/bin/env node
/**
 * Full test battery runner (Phase 4E) — `npm test`.
 *
 * Runs every suite in order: unit suites first, then HTTP e2e, then the real
 * browser suites. Login-using suites are separated by a cooldown because
 * POST /api/auth/login is rate limited per IP (15/min).
 *
 * Requires the app server to be running (SERVER_URL, default localhost:3300).
 *
 * Browser suites that cannot find Chromium exit 77. Those are reported
 * BLOCKED with setup instructions — never passed, never a silent skip.
 * `npm test` then exits 3 if any suite was blocked and none failed
 * (exit 2 remains "no server").
 */
import { spawnSync } from 'node:child_process';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';
const LOGIN_COOLDOWN_MS = Number(process.env.TEST_LOGIN_COOLDOWN_MS ?? 30_000);

/** @type {{ script: string, login: boolean }[]} */
const SUITES = [
  // unit / mock (no HTTP logins)
  { script: 'test:ice-config', login: false },
  { script: 'test:client-ip', login: false },
  { script: 'test:profile', login: false },
  { script: 'test:profile-privacy', login: false },
  { script: 'test:call-engine', login: false },
  { script: 'test:call-phase', login: false },
  { script: 'test:group-call', login: false },
  { script: 'test:calls', login: false },
  { script: 'test:messages', login: false },
  { script: 'test:unread', login: false },
  { script: 'test:notifications', login: false },
  { script: 'test:notifications:phase17', login: false },
  { script: 'test:mobile:phase18', login: false },
  { script: 'test:premium:phase19', login: false },
  { script: 'test:ui:phase22', login: false },
  { script: 'test:notifications:phase17:e2e', login: false },
  { script: 'test:reactions', login: false },
  { script: 'test:voice-upload', login: false },
  { script: 'test:mailer', login: false },
  { script: 'test:storage-delete', login: false },
  { script: 'test:storage-s3', login: false },
  { script: 'test:push', login: false },
  { script: 'test:push-loopback-tls', login: false },
  { script: 'test:chromium-resolve', login: false },
  { script: 'test:notification-retention', login: false },
  { script: 'test:account-deletion', login: false },
  // HTTP e2e (login rate limited)
  { script: 'test:calls:e2e', login: true },
  { script: 'test:ice-api:e2e', login: true },
  { script: 'test:profile:e2e', login: true },
  { script: 'test:profile-privacy:e2e', login: true },
  { script: 'test:profile:browser', login: true },
  { script: 'test:call-notifications:e2e', login: true },
  { script: 'test:voice-upload:e2e', login: true },
  { script: 'test:messages:e2e', login: true },
  { script: 'test:unread:e2e', login: true },
  { script: 'test:notifications:e2e', login: true },
  { script: 'test:reactions:e2e', login: true },
  { script: 'test:reaction-notifications:e2e', login: true },
  // real browsers (login rate limited)
  { script: 'test:calls:browser', login: true },
  { script: 'test:calls:video-browser', login: true },
  { script: 'test:mobile-settings:browser', login: true },
  { script: 'test:wallpaper:e2e', login: true },
  { script: 'test:wallpaper:browser', login: true },
  { script: 'test:call-history:e2e', login: true },
  { script: 'test:call-history:browser', login: true },
  { script: 'test:view-profile:browser', login: true },
  { script: 'test:status:e2e', login: true },
  { script: 'test:status:browser', login: true },
  { script: 'test:status:delete', login: true },
  { script: 'test:status:viewer:browser', login: true },
  { script: 'test:status:add-mobile:browser', login: true },
  { script: 'test:media-access', login: true },
  { script: 'test:hydration:browser', login: true },
  { script: 'test:call-race', login: true },
  { script: 'test:retention', login: true },
  { script: 'test:email-verify', login: true },
  { script: 'test:account-lifecycle', login: true },
  { script: 'test:message-attachments', login: true },
  { script: 'test:socket-revocation', login: true },
  { script: 'test:auth-security', login: true },
  { script: 'test:push:e2e', login: true },
  { script: 'test:rate-limit', login: true },
  // MUST stay last: the push-config E2E rebuilds .next, which invalidates the running server's cached chunk manifests for any suite that runs after it.
  { script: 'test:push-config', login: false }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function preflight() {
  try {
    const res = await fetch(`${SERVER_URL}/login`);
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await preflight())) {
    console.error(`✖ No server reachable at ${SERVER_URL}. Start it first (see README).`);
    process.exit(2);
  }

  const results = [];
  for (const [i, suite] of SUITES.entries()) {
    console.log(`\n════ [${i + 1}/${SUITES.length}] npm run ${suite.script} ════`);
    const res = spawnSync('npm', ['run', '--silent', suite.script], { stdio: 'inherit' });
    // 77 = browser suite blocked (no Chromium). Not a pass, not an assertion failure.
    const status = res.status === 0 ? 'passed' : res.status === 77 ? 'blocked' : 'failed';
    results.push({ script: suite.script, status });
    if (res.status !== 0 && res.status !== 77 && res.signal) {
      console.error(`✖ ${suite.script} terminated by signal ${res.signal}`);
    }
    // Cooldown after login-using suites so the login rate limit never bites.
    if (suite.login && i < SUITES.length - 1) {
      console.log(`  … cooldown ${LOGIN_COOLDOWN_MS / 1000}s (login rate limit)`);
      await sleep(LOGIN_COOLDOWN_MS);
    }
  }

  console.log('\n══════════════════ SUMMARY ══════════════════');
  for (const r of results) {
    const mark = r.status === 'passed' ? '✓' : r.status === 'blocked' ? '!' : '✗';
    console.log(` ${mark} ${r.script}${r.status === 'blocked' ? ' (BLOCKED — browser not installed; not a pass)' : ''}`);
  }
  const failed = results.filter((r) => r.status === 'failed');
  const blocked = results.filter((r) => r.status === 'blocked');
  console.log(
    `\nSUITES ${results.length}  PASSED ${results.length - failed.length - blocked.length}  FAILED ${failed.length}  BLOCKED ${blocked.length}`
  );
  if (blocked.length > 0) {
    console.log(
      'BLOCKED suites were not executed. Install Chromium/Chrome or set CHROMIUM_PATH, then re-run. They are not passes.'
    );
  }
  if (failed.length > 0) process.exit(1);
  if (blocked.length > 0) process.exit(3);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
