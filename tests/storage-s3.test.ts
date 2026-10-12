/**
 * Remediation — attachment cleanup must work through the storage abstraction
 * on S3/R2 private storage too (audit MEDIUM #2, requirement D/E/6).
 *
 * Spins up a minimal S3-compatible stub and points the REAL S3 driver at it,
 * proving `deleteStoredObject` issues the DeleteObject request through the
 * same code path production R2 uses, and that provider errors / missing
 * objects never break a deletion flow.
 *
 * Run: npm run test:storage-s3
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

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

interface SeenRequest {
  method: string;
  url: string;
}

async function main() {
  console.log('■ storage-delete (S3 driver): cleanup through the object-store abstraction');

  const seen: SeenRequest[] = [];
  let respondWith = 204;

  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' });
    req.resume();
    req.on('end', () => {
      res.writeHead(respondWith).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  // Env BEFORE import — the driver is resolved when the module loads.
  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test-key';
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret';

  const { deleteStoredObject } = await import('../src/lib/storage');

  await check('deleteStoredObject sends DeleteObject for the storage key', async () => {
    seen.length = 0;
    respondWith = 204;
    await deleteStoredObject('2026-01-01/media.png');
    const deletes = seen.filter((r) => r.method === 'DELETE');
    assert.equal(deletes.length, 1, `expected 1 DELETE, saw ${JSON.stringify(seen)}`);
    // Path-style addressing: /<bucket>/<key> (the SDK may append signing query
    // params like ?x-id=DeleteObject — compare the pathname only).
    const pathname = deletes[0].url.split('?')[0];
    assert.equal(pathname, '/test-bucket/2026-01-01/media.png');
  });

  await check('provider error never breaks cleanup (best-effort)', async () => {
    seen.length = 0;
    respondWith = 404; // e.g. already gone / access hiccup
    await deleteStoredObject('2026-01-01/gone.png'); // must resolve, not throw
    assert.ok(seen.some((r) => r.method === 'DELETE'));
  });

  await check('missing S3 config fails safe without touching the network', async () => {
    const prevKey = process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_ACCESS_KEY_ID;
    seen.length = 0;
    await deleteStoredObject('2026-01-01/x.png'); // must resolve silently
    process.env.S3_ACCESS_KEY_ID = prevKey;
    assert.equal(seen.length, 0);
  });

  server.close();
  console.log('\n════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
