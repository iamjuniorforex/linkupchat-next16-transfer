/**
 * Browser-launch portability (no browser required).
 *
 * A missing executable must throw BrowserBlockedError with setup
 * instructions. It must not resolve to a hardcoded Linux path, and it must
 * not be reported as a pass.
 *
 * Run: npm run test:chromium-resolve
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserBlockedError, requireChromiumExecutable } from './chromium';

const saved = process.env.CHROMIUM_PATH;

function restore() {
  if (saved === undefined) delete process.env.CHROMIUM_PATH;
  else process.env.CHROMIUM_PATH = saved;
}

try {
  process.env.CHROMIUM_PATH = path.join(tmpdir(), 'linkupchat-missing-chromium');
  let blocked: BrowserBlockedError | null = null;
  try {
    requireChromiumExecutable();
  } catch (err) {
    assert.ok(err instanceof BrowserBlockedError, 'missing CHROMIUM_PATH must be blocked, not a generic failure');
    blocked = err;
  }
  assert.ok(blocked, 'resolver must not return a path when CHROMIUM_PATH is missing');
  assert.match(blocked.message, /CHROMIUM_PATH/);
  assert.match(blocked.instructions, /not a pass/);
  assert.match(blocked.instructions, /macOS/);
  assert.match(blocked.instructions, /Linux/);
  assert.equal(blocked.name, 'BrowserBlockedError');

  const dir = mkdtempSync(path.join(tmpdir(), 'linkup-chrome-'));
  const bin = path.join(dir, 'fake-chromium');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  process.env.CHROMIUM_PATH = bin;
  assert.equal(requireChromiumExecutable(), bin, 'an explicit usable CHROMIUM_PATH is used as-is');

  process.env.CHROMIUM_PATH = '~/this-browser-does-not-exist';
  assert.throws(
    () => requireChromiumExecutable(),
    (err: unknown) => err instanceof BrowserBlockedError && /CHROMIUM_PATH/.test(err.message),
    'a tilde path that does not exist must stay blocked and must not fall back'
  );

  console.log('  ✓ missing browser is blocked with setup instructions');
  console.log('  ✓ usable CHROMIUM_PATH is honored');
  console.log('  ✓ explicit missing path does not fall back to /usr/bin/chromium');
  console.log('\nPASSED 3  FAILED 0');
} finally {
  restore();
}
