/**
 * Phase 16 — username, accent, and phone-search rules. No database.
 */
import assert from 'node:assert/strict';
import {
  isReservedUsername,
  phoneDigits,
  phoneSearchDigits,
  phonesMatch,
  usernameChangeAllowed,
  isProfileAccent
} from '../src/lib/profile-privacy';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}`);
  }
}

check('reserved names are blocked and ordinary names are not', () => {
  assert.equal(isReservedUsername('Admin'), true);
  assert.equal(isReservedUsername('linkupchat'), true);
  assert.equal(isReservedUsername('ada_ok'), false);
});

check('the first username change is free and a recent change is not', () => {
  assert.equal(usernameChangeAllowed('ada', 'ada_new', null).ok, true);
  assert.equal(usernameChangeAllowed('ada', 'ada', new Date()).ok, true);
  const recent = usernameChangeAllowed('ada', 'ada_new', new Date());
  assert.equal(recent.ok, false);
  const old = usernameChangeAllowed('ada', 'ada_new', new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));
  assert.equal(old.ok, true);
  assert.equal(usernameChangeAllowed('ada', 'support', null).ok, false);
});

check('phone search requires a full number and never a fragment', () => {
  assert.equal(phoneSearchDigits('123'), null);
  assert.equal(phoneSearchDigits('12345'), null);
  assert.equal(phoneSearchDigits('+233 24 123 4567'), '233241234567');
  assert.equal(phoneSearchDigits('ada 233241234567'), null);
  assert.equal(phoneDigits('+233-24'), '23324');
  assert.equal(phonesMatch('+233 24 123 4567', '233241234567'), true);
  assert.equal(phonesMatch('+233 24 123 4567', '23324123456'), false);
});

check('accent colors are an allowlist', () => {
  assert.equal(isProfileAccent('#6D5EF5'), true);
  assert.equal(isProfileAccent('#ffffff'), false);
  assert.equal(isProfileAccent('red'), false);
});

console.log(`\nPASSED ${passed}  FAILED ${failed}`);
if (failed) process.exit(1);
