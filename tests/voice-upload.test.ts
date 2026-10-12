/**
 * Voice-message upload compatibility — unit tests.
 *
 * Covers the root cause of the voice-upload failure (MediaRecorder MIME
 * parameters like `audio/webm;codecs=opus` breaking exact-match classification)
 * and the fix: parameter-tolerant classification with UNCHANGED content
 * validation, real recorder-MIME preservation, and consistent naming.
 *
 * Run: npm run test:voice-upload
 */
import assert from 'node:assert/strict';
import { normalizeMime, extensionForMime, chooseVoiceMime, VOICE_RECORDER_MIME_CANDIDATES } from '../src/lib/mime';
import { classifyMime, storeUpload, MAX_UPLOAD_BYTES, sanitizeFileName } from '../src/lib/storage';
import { sniffMime, sniffMatchesClaim } from '../src/lib/media';

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

// Minimal but sniffable containers (>12 bytes so sniffMime engages).
const WEBM_BYTES = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, 0x42, 0x86, 0x81, 0x01,
  0x42, 0xf7, 0x81, 0x01
]);
const OGG_BYTES = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24, 0)]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0)
]);
const M4A_BYTES = (() => {
  const b = Buffer.alloc(24, 0);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  b.write('M4A ', 8, 'latin1');
  return b;
})();

async function main() {
  console.log('■ MIME normalization (the recorded type keeps its parameters)');
  await check('normalizeMime strips codecs parameters', () => {
    assert.equal(normalizeMime('audio/webm;codecs=opus'), 'audio/webm');
    assert.equal(normalizeMime('audio/ogg;codecs=opus'), 'audio/ogg');
    assert.equal(normalizeMime('audio/mp4;codecs=mp4a.40.2'), 'audio/mp4');
    assert.equal(normalizeMime('audio/webm;codecs=opus;extra=1'), 'audio/webm');
  });
  await check('normalizeMime lowercases and trims without altering bare types', () => {
    assert.equal(normalizeMime(' Audio/OGG; Codecs=Opus '), 'audio/ogg');
    assert.equal(normalizeMime('audio/webm'), 'audio/webm');
    assert.equal(normalizeMime(''), '');
  });

  console.log('\n■ classification accepts realistic MediaRecorder types (validation preserved)');
  await check('audio/webm;codecs=opus classifies as audio (the original bug)', () => {
    assert.equal(classifyMime('audio/webm;codecs=opus'), 'audio');
  });
  await check('audio/ogg;codecs=opus and audio/mp4;codecs=… classify as audio', () => {
    assert.equal(classifyMime('audio/ogg;codecs=opus'), 'audio');
    assert.equal(classifyMime('audio/mp4;codecs=mp4a.40.2'), 'audio');
    assert.equal(classifyMime('audio/x-m4a'), 'audio');
  });
  await check('unknown or non-allowlisted types are STILL rejected', () => {
    assert.equal(classifyMime('audio/x-evil;codecs=opus'), null);
    assert.equal(classifyMime('application/x-evil'), null);
    assert.equal(classifyMime('text/html'), null);
    assert.equal(classifyMime('audio/webm.exe'), null);
  });
  await check('image/video/document classification is unchanged', () => {
    assert.equal(classifyMime('image/png'), 'image');
    assert.equal(classifyMime('image/png;foo=bar'), 'image');
    assert.equal(classifyMime('image/gif'), 'gif');
    assert.equal(classifyMime('image/webp'), 'sticker');
    assert.equal(classifyMime('video/mp4'), 'video');
    assert.equal(classifyMime('application/pdf'), 'document');
    assert.equal(classifyMime('text/plain'), 'document');
  });

  console.log('\n■ recorder MIME selection + filename/extension agreement');
  await check('Chrome (WebM/Opus) picks audio/webm;codecs=opus', () => {
    const t = chooseVoiceMime((x) => x.startsWith('audio/webm'));
    assert.equal(t, 'audio/webm;codecs=opus');
  });
  await check('Firefox (Ogg/Opus) picks audio/ogg;codecs=opus', () => {
    const t = chooseVoiceMime((x) => x.startsWith('audio/ogg'));
    assert.equal(t, 'audio/ogg;codecs=opus');
  });
  await check('Safari (MP4 only) picks audio/mp4 before video/mp4', () => {
    const t = chooseVoiceMime((x) => x === 'audio/mp4' || x === 'video/mp4');
    assert.equal(t, 'audio/mp4');
    const t2 = chooseVoiceMime((x) => x === 'video/mp4');
    assert.equal(t2, 'video/mp4');
  });
  await check('returns null when nothing is supported (caller falls back to the default)', () => {
    assert.equal(chooseVoiceMime(() => false), null);
    assert.ok(VOICE_RECORDER_MIME_CANDIDATES.length >= 5);
  });
  await check('extensionForMime agrees with the actual recorded type', () => {
    assert.equal(extensionForMime('audio/webm;codecs=opus'), 'webm');
    assert.equal(extensionForMime('audio/webm'), 'webm');
    assert.equal(extensionForMime('audio/ogg;codecs=opus'), 'ogg');
    assert.equal(extensionForMime('audio/mp4'), 'm4a');
    assert.equal(extensionForMime('audio/x-m4a'), 'm4a');
    assert.equal(extensionForMime('video/mp4'), 'mp4');
    assert.equal(extensionForMime('audio/mpeg'), 'mp3');
    assert.equal(extensionForMime('unknown/xyz'), 'bin');
  });

  console.log('\n■ content sniffing (still strict — parameters never weaken it)');
  await check('sniffMatchesClaim accepts webm/ogg claims WITH codecs parameters', () => {
    assert.equal(sniffMatchesClaim('audio/webm;codecs=opus', sniffMime(WEBM_BYTES)), true);
    assert.equal(sniffMatchesClaim('audio/ogg;codecs=opus', sniffMime(OGG_BYTES)), true);
  });
  await check('sniffMatchesClaim still rejects content that does not match the claim', () => {
    assert.equal(sniffMatchesClaim('audio/webm;codecs=opus', sniffMime(PNG_BYTES)), false);
    assert.equal(sniffMatchesClaim('audio/ogg;codecs=opus', sniffMime(WEBM_BYTES)), false);
    assert.equal(sniffMatchesClaim('image/png', sniffMime(WEBM_BYTES)), false);
  });

  console.log('\n■ storeUpload: short voice recordings (the failing path)');
  await check('short WebM recording with codecs parameter stores as audio/webm', async () => {
    const out = await storeUpload({
      file: WEBM_BYTES,
      mimeType: 'audio/webm;codecs=opus',
      fileName: 'voice-message.webm'
    });
    assert.equal(out.mimeType, 'audio/webm', `stored mimeType=${out.mimeType}`);
    assert.equal(out.sizeBytes, WEBM_BYTES.length);
    assert.equal(out.fileName, 'voice-message.webm');
    assert.ok(out.storageKey.endsWith('.weba'), `key=${out.storageKey}`);
  });
  await check('Ogg/Opus recording (Firefox) stores as audio/ogg', async () => {
    const out = await storeUpload({
      file: OGG_BYTES,
      mimeType: 'audio/ogg;codecs=opus',
      fileName: 'voice-message.ogg'
    });
    assert.equal(out.mimeType, 'audio/ogg');
    assert.equal(out.fileName, 'voice-message.ogg');
  });
  await check('MP4 audio recording (Safari) with codecs parameter stores as audio/mp4', async () => {
    const out = await storeUpload({
      file: M4A_BYTES,
      mimeType: 'audio/mp4;codecs=mp4a.40.2',
      fileName: 'voice-message.m4a'
    });
    assert.equal(out.mimeType, 'audio/mp4');
    assert.equal(out.fileName, 'voice-message.m4a');
  });

  console.log('\n■ security checks unchanged');
  await check('oversized upload is still rejected', async () => {
    await assert.rejects(
      () =>
        storeUpload({
          file: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1),
          mimeType: 'audio/webm;codecs=opus',
          fileName: 'big.webm'
        }),
      /too large/
    );
  });
  await check('non-audio bytes under an audio claim are still rejected', async () => {
    await assert.rejects(
      () =>
        storeUpload({
          file: PNG_BYTES,
          mimeType: 'audio/webm;codecs=opus',
          fileName: 'fake.webm'
        }),
      /does not match/
    );
    await assert.rejects(
      () => storeUpload({ file: PNG_BYTES, mimeType: 'audio/ogg;codecs=opus', fileName: 'fake.ogg' }),
      /does not match/
    );
  });
  await check('unallowlisted types are still rejected before any write', async () => {
    await assert.rejects(
      () => storeUpload({ file: WEBM_BYTES, mimeType: 'audio/x-evil;codecs=opus', fileName: 'x.webm' }),
      /Unsupported file type/
    );
    await assert.rejects(
      () => storeUpload({ file: PNG_BYTES, mimeType: 'application/x-evil', fileName: 'x.bin' }),
      /Unsupported file type/
    );
  });
  await check('normal PNG upload path is unaffected (stored as image/png)', async () => {
    const out = await storeUpload({ file: PNG_BYTES, mimeType: 'image/png', fileName: 'pic.png' });
    assert.equal(out.mimeType, 'image/png');
    assert.equal(out.fileName, 'pic.png');
  });
  await check('sanitizeFileName still strips unsafe characters', () => {
    assert.equal(sanitizeFileName('voice message (1).webm'), 'voice_message__1_.webm');
    assert.equal(sanitizeFileName('a/b\\c:d'), 'a_b_c_d');
  });
}

main().then(() => {
  console.log('\n════════════════════════════════════');
  console.log(`PASSED ${passed}  FAILED ${failed}`);
  process.exit(failed ? 1 : 0);
});
