/**
 * Voice-message upload e2e — HTTP against the running server.
 *
 * Verifies the real failing path end-to-end: MediaRecorder-style uploads with
 * MIME parameters, VOICE attachment + message creation, size/type rejections
 * staying intact, and normal uploads remaining unaffected.
 *
 * Run: npm run test:voice-upload:e2e   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import { api, createReporter, login, type Session } from './helpers';

const BASE = process.env.SERVER_URL ?? 'http://localhost:3300';
const report = createReporter();

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

interface UploadResult {
  status: number;
  ok: boolean;
  code?: string;
  message?: string;
  data?: {
    id: string;
    kind: string;
    mimeType: string;
    fileName: string;
    sizeBytes: number;
  };
}

async function upload(
  s: Session | null,
  bytes: Buffer,
  type: string,
  name: string,
  purpose = 'voice'
): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(bytes)], name, { type }), name);
  fd.append('purpose', purpose);
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    body: fd,
    headers: s ? { Cookie: s.cookie } : undefined
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, never>;
  return {
    status: res.status,
    ok: Boolean((json as { ok?: boolean }).ok),
    code: (json as { error?: { code?: string } }).error?.code,
    message: (json as { error?: { message?: string } }).error?.message,
    data: (json as { data?: UploadResult['data'] }).data
  };
}

async function main() {
  const alex = await login('alex');
  const emma = await login('emma');

  const convRes = await api<{ data?: { conversations?: { id: string; peer?: { username?: string } }[] } }>(
    alex,
    'GET',
    '/api/conversations'
  );
  const direct = (convRes.json.data?.conversations ?? []).find((c) => c.peer?.username === 'emma');
  assert.ok(direct, 'alex↔emma conversation not found');
  const convId = direct!.id;

  // ── the failing path: MediaRecorder MIME with codecs parameters ──
  await report.check('short WebM recording (audio/webm;codecs=opus) uploads as VOICE', async () => {
    const r = await upload(alex, WEBM_BYTES, 'audio/webm;codecs=opus', 'voice-message.webm');
    assert.equal(r.status, 200, `status=${r.status} ${r.message ?? ''}`);
    assert.equal(r.data!.kind, 'VOICE', `kind=${r.data!.kind}`);
    assert.equal(r.data!.mimeType, 'audio/webm', `mimeType=${r.data!.mimeType}`);
    assert.equal(r.data!.fileName, 'voice-message.webm');
    assert.equal(r.data!.sizeBytes, WEBM_BYTES.length);
  });

  await report.check('Ogg/Opus recording (Firefox) uploads as VOICE with its own extension', async () => {
    const r = await upload(alex, OGG_BYTES, 'audio/ogg;codecs=opus', 'voice-message.ogg');
    assert.equal(r.status, 200, `status=${r.status} ${r.message ?? ''}`);
    assert.equal(r.data!.kind, 'VOICE');
    assert.equal(r.data!.mimeType, 'audio/ogg');
    assert.equal(r.data!.fileName, 'voice-message.ogg');
  });

  await report.check('MP4 audio recording (Safari) with codecs parameter uploads as VOICE', async () => {
    const r = await upload(alex, M4A_BYTES, 'audio/mp4;codecs=mp4a.40.2', 'voice-message.m4a');
    assert.equal(r.status, 200, `status=${r.status} ${r.message ?? ''}`);
    assert.equal(r.data!.kind, 'VOICE');
    assert.equal(r.data!.mimeType, 'audio/mp4');
  });

  await report.check('bare audio/webm and audio/ogg keep working', async () => {
    const w = await upload(alex, WEBM_BYTES, 'audio/webm', 'voice-message.webm');
    const o = await upload(alex, OGG_BYTES, 'audio/ogg', 'voice-message.ogg');
    assert.equal(w.status, 200);
    assert.equal(o.status, 200);
    assert.equal(w.data!.kind, 'VOICE');
    assert.equal(o.data!.kind, 'VOICE');
    assert.equal(w.data!.mimeType, 'audio/webm');
    assert.equal(o.data!.mimeType, 'audio/ogg');
  });

  // ── VOICE attachment + message creation ──
  await report.check('attachment attaches to a VOICE message with the real MIME preserved', async () => {
    const up = await upload(alex, WEBM_BYTES, 'audio/webm;codecs=opus', 'voice-message.webm');
    const sent = await api<{ data?: { message?: { type: string; attachments?: { kind: string; mimeType: string; fileName: string }[] } } }>(
      alex,
      'POST',
      `/api/conversations/${convId}/messages`,
      { type: 'VOICE', attachmentIds: [up.data!.id], content: '' }
    );
    assert.ok(sent.status === 200 || sent.status === 201, `status=${sent.status}`);
    const msg = sent.json.data?.message;
    assert.equal(msg?.type, 'VOICE');
    const att = msg?.attachments?.[0];
    assert.ok(att, 'no attachment on the message');
    assert.equal(att!.kind, 'VOICE', `kind=${att!.kind}`);
    assert.equal(att!.mimeType, 'audio/webm', `mimeType=${att!.mimeType}`);
    assert.equal(att!.fileName, 'voice-message.webm');
  });

  await report.check('attachment ownership is enforced (cannot use someone else\u2019s upload)', async () => {
    const up = await upload(alex, WEBM_BYTES, 'audio/webm', 'voice-message.webm');
    const stolen = await api(emma, 'POST', `/api/conversations/${convId}/messages`, {
      type: 'VOICE',
      attachmentIds: [up.data!.id],
      content: ''
    });
    assert.equal(stolen.status, 400, `status=${stolen.status}`);
  });

  // ── security checks unchanged ──
  await report.check('oversized voice upload is still rejected as FILE_TOO_LARGE', async () => {
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
    big.set(WEBM_BYTES.subarray(0, 20), 0); // still webm-signatured
    const r = await upload(alex, big, 'audio/webm;codecs=opus', 'big.webm');
    assert.equal(r.status, 400, `status=${r.status}`);
    assert.equal(r.code, 'FILE_TOO_LARGE', `code=${r.code}`);
    assert.ok(!/unsupported file size/i.test(r.message ?? ''), 'must not mislabel as a type error');
  });

  await report.check('invalid/non-audio content is still rejected under an audio claim', async () => {
    const r = await upload(alex, PNG_BYTES, 'audio/webm;codecs=opus', 'fake.webm');
    assert.equal(r.status, 400, `status=${r.status}`);
    assert.ok(
      r.code === 'UNSUPPORTED_TYPE' || r.message?.includes('does not match'),
      `code=${r.code} message=${r.message}`
    );
  });

  await report.check('unallowlisted types are still rejected', async () => {
    const r = await upload(alex, WEBM_BYTES, 'audio/x-evil;codecs=opus', 'x.webm');
    assert.equal(r.status, 400);
    assert.equal(r.code, 'UNSUPPORTED_TYPE');
  });

  await report.check('upload requires authentication', async () => {
    const r = await upload(null, WEBM_BYTES, 'audio/webm;codecs=opus', 'voice-message.webm');
    assert.equal(r.status, 401);
  });

  // ── normal uploads unaffected ──
  await report.check('normal PNG message upload still works (IMAGE, unchanged)', async () => {
    const r = await upload(alex, PNG_BYTES, 'image/png', 'pic.png', 'message');
    assert.equal(r.status, 200, `status=${r.status} ${r.message ?? ''}`);
    assert.equal(r.data!.kind, 'IMAGE');
    assert.equal(r.data!.mimeType, 'image/png');
    assert.equal(r.data!.fileName, 'pic.png');
  });

  await report.check('documents still validate (PDF claim over PNG bytes rejected)', async () => {
    const r = await upload(alex, PNG_BYTES, 'application/pdf', 'doc.pdf', 'message');
    assert.equal(r.status, 400);
  });
}

main()
  .then(() => report.finish())
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
