/**
 * Remediation — attachment cleanup must work through the storage abstraction
 * on local disk (audit MEDIUM #2, requirement D/E).
 *
 * Env is set BEFORE the storage module is imported (the driver is resolved at
 * module load). Verifies: object deletion works, already-missing objects are
 * tolerated, and the path-traversal guard is unchanged.
 *
 * Run: npm run test:storage-delete
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
}

async function main() {
  console.log('■ storage-delete (local driver): object cleanup is safe and tolerant');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkup-storage-'));
  process.env.STORAGE_DRIVER = 'local';
  process.env.UPLOAD_DIR = tmp;

  // Import AFTER the env setup — the driver/UPLOAD_DIR are module constants.
  const { deleteStoredObject, resolveLocalPath } = await import('../src/lib/storage');

  await check('deleteStoredObject removes an existing object', async () => {
    const key = '2026-01-01/abc.png';
    fs.mkdirSync(path.join(tmp, '2026-01-01'), { recursive: true });
    fs.writeFileSync(path.join(tmp, key), 'bytes');
    await deleteStoredObject(key);
    assert.equal(fs.existsSync(path.join(tmp, key)), false);
  });

  await check('deleteStoredObject tolerates an already-missing object', async () => {
    await deleteStoredObject('2026-01-01/never-existed.png'); // must not throw
  });

  await check('path traversal is still rejected', async () => {
    assert.throws(() => resolveLocalPath('../secrets.txt'), /Invalid file path/);
    assert.throws(() => resolveLocalPath('a/../../b'), /Invalid file path/);
  });

  await check('resolveLocalPath resolves inside UPLOAD_DIR', async () => {
    const full = resolveLocalPath('2026-01-01/x.png');
    assert.ok(full.startsWith(tmp + path.sep));
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
