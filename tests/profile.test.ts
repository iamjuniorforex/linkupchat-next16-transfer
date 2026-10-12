/**
 * Phase 5A — profile validation unit tests (updateProfileSchema).
 *
 * Pure schema tests: display name, About/bio, username, avatarUrl. Server
 * routes stay authoritative (covered by tests/profile.e2e.ts).
 *
 * Run: npm run test:profile
 */
import assert from 'node:assert/strict';
import { updateProfileSchema } from '../src/lib/validation';

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

async function main() {
  console.log('■ profile: display name');

  await check('trims leading/trailing whitespace', () => {
    const r = updateProfileSchema.parse({ displayName: '  Ama Serwaa  ' });
    assert.equal(r.displayName, 'Ama Serwaa');
  });

  await check('accepts Unicode: emoji, Amharic, RTL', () => {
    const name = 'Ama 👩🏾‍💻 አማርኛ مرحبا';
    assert.equal(updateProfileSchema.parse({ displayName: name }).displayName, name);
  });

  await check('rejects empty and whitespace-only names', () => {
    assert.throws(() => updateProfileSchema.parse({ displayName: '' }));
    assert.throws(() => updateProfileSchema.parse({ displayName: '   ' }));
    assert.throws(() => updateProfileSchema.parse({ displayName: 'A' }), 'single char rejected');
  });

  await check('enforces 2–50 characters', () => {
    assert.equal(updateProfileSchema.parse({ displayName: 'Ab' }).displayName, 'Ab');
    assert.equal(updateProfileSchema.parse({ displayName: 'X'.repeat(50) }).displayName?.length, 50);
    assert.throws(() => updateProfileSchema.parse({ displayName: 'X'.repeat(51) }));
  });

  console.log('\n■ profile: about/bio');

  await check('optional; trims whitespace; allows empty string', () => {
    assert.equal(updateProfileSchema.parse({}).about, undefined);
    assert.equal(updateProfileSchema.parse({ about: '  Hello there.  ' }).about, 'Hello there.');
    assert.equal(updateProfileSchema.parse({ about: '' }).about, '');
  });

  await check('enforces the 140-character maximum', () => {
    assert.equal(updateProfileSchema.parse({ about: 'X'.repeat(140) }).about?.length, 140);
    assert.throws(() => updateProfileSchema.parse({ about: 'X'.repeat(141) }));
  });

  await check('plain text only: markup is stored verbatim (never interpreted)', () => {
    const xssy = '<img src=x onerror=alert(1)> & "quotes" \'apostrophes\'';
    assert.equal(updateProfileSchema.parse({ about: xssy }).about, xssy);
  });

  console.log('\n■ profile: username (existing rules preserved)');

  await check('normalizes to lowercase and trims', () => {
    assert.equal(updateProfileSchema.parse({ username: '  New_User_1 ' }).username, 'new_user_1');
  });

  await check('rejects invalid shapes (same regex as registration)', () => {
    for (const bad of ['ab', 'a-b', 'has space', 'dot.name', 'X'.repeat(25), '😀user', '']) {
      assert.throws(() => updateProfileSchema.parse({ username: bad }), `should reject ${JSON.stringify(bad)}`);
    }
  });

  await check('accepts valid usernames (3–24, a-z 0-9 _)', () => {
    for (const good of ['abc', 'alex', 'user_name_99', 'x'.repeat(24)]) {
      assert.equal(updateProfileSchema.parse({ username: good }).username, good);
    }
  });

  console.log('\n■ profile: avatarUrl + ownership shape');

  await check('avatarUrl is optional, nullable, bounded', () => {
    assert.equal(updateProfileSchema.parse({}).avatarUrl, undefined);
    assert.equal(updateProfileSchema.parse({ avatarUrl: null }).avatarUrl, null);
    assert.equal(updateProfileSchema.parse({ avatarUrl: '/api/files/ab/cd.png' }).avatarUrl, '/api/files/ab/cd.png');
    assert.throws(() => updateProfileSchema.parse({ avatarUrl: '' }), 'empty string rejected');
    assert.throws(() => updateProfileSchema.parse({ avatarUrl: 'x'.repeat(1025) }), 'over-long rejected');
  });

  await check('unknown fields (e.g. a client-supplied id) are stripped, never trusted', () => {
    const r = updateProfileSchema.parse({ displayName: 'Ama', id: 'usr_someone_else', role: 'ADMIN' });
    assert.deepEqual(Object.keys(r).sort(), ['displayName']);
    assert.equal((r as Record<string, unknown>).id, undefined);
    assert.equal((r as Record<string, unknown>).role, undefined);
  });

  await check('partial updates: any single field alone', () => {
    assert.deepEqual(Object.keys(updateProfileSchema.parse({ about: 'x' })), ['about']);
    assert.deepEqual(Object.keys(updateProfileSchema.parse({ username: 'abc' })), ['username']);
    assert.deepEqual(Object.keys(updateProfileSchema.parse({ avatarUrl: null })), ['avatarUrl']);
  });

  console.log('════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
