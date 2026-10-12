/**
 * Phase 4E — ICE configuration parsing, validation and secret redaction.
 *
 * Pure unit tests (no server): parseIceConfig / describeIceConfigForLog /
 * redactSecrets. API delivery is covered by tests/ice-api.e2e.ts; the
 * browser suites verify the engine actually applies the fetched config.
 *
 * Run: npm run test:ice-config
 */
import assert from 'node:assert/strict';
import {
  parseIceConfig,
  describeIceConfigForLog,
  redactSecrets,
  getIceConfig,
  resetIceConfigCache
} from '../src/lib/ice-config';

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

const CRED = 'sup3r-secret-credential';
const USER = 'turn-account-user';

async function main() {
  console.log('■ ice-config: STUN parsing');

  await check('empty env → default public STUN pair, no TURN', () => {
    const r = parseIceConfig({});
    assert.equal(r.iceServers.length, 1);
    assert.deepEqual(r.iceServers[0]!.urls, ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']);
    assert.equal(r.summary.turnUrlCount, 0);
    assert.equal(r.summary.turnAuthConfigured, false);
    assert.equal(r.warnings.length, 0);
  });

  await check('STUN_URLS: single URL', () => {
    const r = parseIceConfig({ STUN_URLS: 'stun:stun.example.com:3478' });
    assert.deepEqual(r.iceServers[0]!.urls, ['stun:stun.example.com:3478']);
    assert.equal(r.summary.stunUrlCount, 1);
  });

  await check('STUN_URLS: multiple URLs, comma/space separated + whitespace trimmed', () => {
    const r = parseIceConfig({ STUN_URLS: ' stun:a.example:3478 ,  stun:b.example:3478  stuns:c.example:5349 ' });
    assert.deepEqual(r.iceServers[0]!.urls, ['stun:a.example:3478', 'stun:b.example:3478', 'stuns:c.example:5349']);
    assert.equal(r.summary.stunUrlCount, 3);
  });

  await check('STUN_URLS: unsupported schemes are skipped with a warning', () => {
    const r = parseIceConfig({ STUN_URLS: 'https://not-stun.example, stun:good.example:3478, ftp:bad.example' });
    assert.deepEqual(r.iceServers[0]!.urls, ['stun:good.example:3478']);
    assert.equal(r.warnings.length, 2);
  });

  console.log('\n■ ice-config: TURN parsing (UDP / TCP / TLS, multiple URLs)');

  await check('TURN_URLS: UDP, TCP and TLS URLs all accepted; protocols summarized', () => {
    const r = parseIceConfig({
      TURN_URLS: 'turn:relay.example.com:3478, turn:relay.example.com:3478?transport=tcp, turns:relay.example.com:5349',
      TURN_USERNAME: USER,
      TURN_CREDENTIAL: CRED
    });
    assert.equal(r.iceServers.length, 2);
    const turn = r.iceServers[1]!;
    assert.deepEqual(turn.urls, [
      'turn:relay.example.com:3478',
      'turn:relay.example.com:3478?transport=tcp',
      'turns:relay.example.com:5349'
    ]);
    assert.equal(turn.username, USER);
    assert.equal(turn.credential, CRED);
    assert.deepEqual(r.summary.turnProtocols, ['tcp', 'tls', 'udp']);
    assert.equal(r.summary.turnAuthConfigured, true);
  });

  await check('TURN_URLS: multiple TURN servers in one list', () => {
    const r = parseIceConfig({
      TURN_URLS: 'turn:a.example:3478,turn:b.example:3478',
      TURN_USERNAME: USER,
      TURN_CREDENTIAL: CRED
    });
    assert.equal(r.summary.turnUrlCount, 2);
    assert.equal(r.summary.turnProtocols.join(','), 'udp');
  });

  await check('turns: URLs are TLS even without ?transport', () => {
    const r = parseIceConfig({
      TURN_URLS: 'turns:secure.example.com:443',
      TURN_USERNAME: USER,
      TURN_CREDENTIAL: CRED
    });
    assert.deepEqual(r.summary.turnProtocols, ['tls']);
  });

  await check('STUN stays first in iceServers (direct candidates before relay)', () => {
    const r = parseIceConfig({
      STUN_URLS: 'stun:s.example:3478',
      TURN_URLS: 'turn:r.example:3478',
      TURN_USERNAME: USER,
      TURN_CREDENTIAL: CRED
    });
    assert.equal((r.iceServers[0]!.urls as string[])[0], 'stun:s.example:3478');
    assert.match(String((r.iceServers[1]!.urls as string[])[0]), /^turn:/);
  });

  console.log('\n■ ice-config: missing / malformed configuration (never crashes)');

  await check('missing TURN entirely → STUN-only, zero warnings', () => {
    const r = parseIceConfig({ STUN_URLS: 'stun:x.example:3478' });
    assert.equal(r.iceServers.length, 1);
    assert.equal(r.warnings.length, 0);
  });

  await check('TURN_URLS without username/credential → TURN ignored + safe warning', () => {
    const r = parseIceConfig({ TURN_URLS: 'turn:r.example:3478' });
    assert.equal(r.iceServers.length, 1, 'STUN only');
    assert.equal(r.summary.turnAuthConfigured, false);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /TURN_USERNAME\/TURN_CREDENTIAL/);
  });

  await check('username without credential (and vice versa) → TURN ignored', () => {
    const a = parseIceConfig({ TURN_URLS: 'turn:r.example:3478', TURN_USERNAME: USER });
    const b = parseIceConfig({ TURN_URLS: 'turn:r.example:3478', TURN_CREDENTIAL: CRED });
    for (const r of [a, b]) {
      assert.equal(r.iceServers.length, 1);
      assert.equal(r.warnings.length, 1);
    }
  });

  await check('credentials without TURN_URLS → ignored + warning', () => {
    const r = parseIceConfig({ TURN_USERNAME: USER, TURN_CREDENTIAL: CRED });
    assert.equal(r.iceServers.length, 1, 'STUN only');
    assert.equal(r.warnings.length, 1);
  });

  await check('malformed TURN URLs are skipped; valid ones survive', () => {
    const r = parseIceConfig({
      TURN_URLS: 'http://bad.example, turn://weird.example, garbage, turn:good.example:3478',
      TURN_USERNAME: USER,
      TURN_CREDENTIAL: CRED
    });
    assert.deepEqual((r.iceServers[1]?.urls ?? []) as string[], ['turn:good.example:3478']);
    assert.equal(r.warnings.length, 3);
  });

  await check('malformed everything → empty-but-valid config, no throw', () => {
    const r = parseIceConfig({ STUN_URLS: ':::', TURN_URLS: ':::', TURN_USERNAME: '', TURN_CREDENTIAL: '' });
    assert.deepEqual(r.iceServers, []);
    assert.ok(r.warnings.length >= 1);
  });

  await check('URL count is capped (abuse safety)', () => {
    const many = Array.from({ length: 40 }, (_, i) => `turn:t${i}.example:3478`).join(',');
    const r = parseIceConfig({ TURN_URLS: many, TURN_USERNAME: USER, TURN_CREDENTIAL: CRED });
    assert.equal(r.summary.turnUrlCount, 16);
    assert.match(r.warnings.join(' '), /only the first 16/);
  });

  console.log('\n■ ice-config: secret redaction');

  await check('describeIceConfigForLog never contains the credential or username', () => {
    const r = parseIceConfig({
      STUN_URLS: 'stun:s.example:3478',
      TURN_URLS: 'turn:r.example:3478',
      TURN_USERNAME: USER,
      TURN_CREDENTIAL: CRED
    });
    const line = describeIceConfigForLog(r);
    assert.ok(!line.includes(CRED), 'credential leaked into log line');
    assert.ok(!line.includes(USER), 'username leaked into log line');
    assert.match(line, /1 STUN url\(s\), 1 TURN url\(s\) \(udp\), turn auth configured/);
  });

  await check('warnings never contain credentials (malformed-URL paths included)', () => {
    const r = parseIceConfig({
      STUN_URLS: `https://${CRED}.example`,
      TURN_URLS: `https://${USER}:${CRED}@bad.example, turn:ok.example:3478`,
      TURN_USERNAME: USER,
      TURN_CREDENTIAL: CRED
    });
    const all = r.warnings.join(' | ');
    assert.ok(!all.includes(CRED), 'credential leaked into warnings');
    assert.ok(!all.includes(USER), 'username leaked into warnings');
  });

  await check('redactSecrets masks every occurrence in arbitrary text', () => {
    const out = redactSecrets(`user=${USER} pass=${CRED} again=${CRED} short=xy`, [USER, CRED, undefined, 'xy']);
    assert.ok(!out.includes(CRED));
    assert.ok(!out.includes(USER));
    assert.match(out, /\[redacted\]/);
    assert.equal(out.includes('short=xy'), true, 'too-short secrets are not masked');
  });

  console.log('\n■ ice-config: memoized env access');

  await check('getIceConfig() parses the real environment once and can be reset', () => {
    resetIceConfigCache();
    const a = getIceConfig();
    const b = getIceConfig();
    assert.equal(a, b, 'memoized');
    resetIceConfigCache();
    const c = getIceConfig();
    assert.notEqual(a, c, 'fresh after reset');
  });

  console.log('════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
