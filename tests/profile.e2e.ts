/**
 * Phase 5A — profile foundation e2e (HTTP against the running server).
 *
 * Covers: session-authoritative edits, display name/username/About validation,
 * username uniqueness, avatar upload → attach → replace/cleanup, rejection of
 * foreign/arbitrary avatar URLs, plain-text About guarantees, and that a
 * failed upload/update never corrupts the profile.
 *
 * Run: npm run test:profile:e2e   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import { SERVER_URL, api, createReporter, login, uniq, sleep, type Session } from './helpers';

const report = createReporter();

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0)
]);
const WEBM_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00]);

interface Me {
  ok: boolean;
  data?: {
    id: string;
    username: string;
    displayName: string;
    about: string;
    avatarUrl: string | null;
  };
  error?: { code?: string; message?: string; details?: Record<string, string[] | undefined> };
}

async function register(username: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Passw0rd123',
      displayName: 'Profile Tester',
      email: `${username}@example.com`
    })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function me(s: Session) {
  const { status, json } = await api<Me>(s, 'GET', '/api/auth/me');
  assert.equal(status, 200);
  return json.data!;
}

async function patchProfile(s: Session, body: unknown) {
  return api<Me>(s, 'PATCH', '/api/users/me', body);
}

async function uploadAvatar(s: Session, bytes: Buffer, type = 'image/png', name = 'avatar.png', purpose = 'avatar') {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(bytes)], name, { type }), name);
  fd.append('purpose', purpose);
  const res = await fetch(`${SERVER_URL}/api/upload`, {
    method: 'POST',
    body: fd,
    headers: { Cookie: s.cookie }
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok: boolean;
    data?: { id: string; url: string; kind: string };
    error?: { code?: string; message?: string };
  };
  return { status: res.status, ...json };
}

async function main() {
  const u = `prof_a_${uniq().replace(/-/g, '')}`.slice(0, 24);
  const u2 = `prof_b_${uniq().replace(/-/g, '')}`.slice(0, 24);
  assert.notEqual(u, u2, 'test usernames must be distinct');
  console.log(`■ profile.e2e (${u}, ${u2})`);

  const alice = await register(u);
  const bob = await register(u2);
  assert.notEqual(alice.id, bob.id, 'test users must be distinct accounts');

  await report.check('unauthenticated PATCH /api/users/me is rejected (401)', async () => {
    const res = await fetch(`${SERVER_URL}/api/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nope' })
    });
    assert.equal(res.status, 401);
    assert.equal(res.ok, false);
  });

  await report.check('display name: trimmed and Unicode preserved', async () => {
    const name = '  Ama 👩🏾‍💻 አማርኛ  ';
    const { status, json } = await patchProfile(alice, { displayName: name });
    assert.equal(status, 200);
    assert.equal(json.data?.displayName, 'Ama 👩🏾‍💻 አማርኛ', 'server trims');
    assert.equal((await me(alice)).displayName, 'Ama 👩🏾‍💻 አማርኛ');
  });

  await report.check('display name: empty/whitespace/too-long rejected with field errors', async () => {
    for (const bad of ['', '   ', 'A', 'X'.repeat(51)]) {
      const { status, json } = await patchProfile(alice, { displayName: bad });
      assert.equal(status, 422, `should reject ${JSON.stringify(bad.slice(0, 8))}`);
      assert.equal(json.error?.code, 'VALIDATION_ERROR');
      assert.ok(json.error?.details?.displayName, 'field error for displayName');
    }
    assert.equal((await me(alice)).displayName, 'Ama 👩🏾‍💻 አማርኛ', 'profile unchanged by bad saves');
  });

  await report.check('about: 140 chars accepted, 141 rejected with field error', async () => {
    const ok140 = 'X'.repeat(140);
    assert.equal((await patchProfile(alice, { about: ok140 })).status, 200);
    assert.equal((await me(alice)).about, ok140);
    const { status, json } = await patchProfile(alice, { about: 'X'.repeat(141) });
    assert.equal(status, 422);
    assert.ok(json.error?.details?.about, 'field error for about');
    assert.equal((await me(alice)).about, ok140, 'profile unchanged');
  });

  await report.check('about: markup is stored and returned as PLAIN TEXT (no interpretation)', async () => {
    const xssy = '<img src=x onerror=alert(1)> & "quotes" <b>bold</b>';
    assert.equal((await patchProfile(alice, { about: xssy })).status, 200);
    assert.equal((await me(alice)).about, xssy, 'exact round-trip, nothing rendered/stripped into HTML');
  });

  await report.check('username: change works, normalizes to lowercase', async () => {
    const renamed = `ren_${uniq().replace(/-/g, '')}`.slice(0, 24);
    const { status, json } = await patchProfile(alice, { username: renamed.toUpperCase() });
    assert.equal(status, 200);
    assert.equal(json.data?.username, renamed.toLowerCase());
  });

  await report.check('username: invalid shapes rejected with field errors', async () => {
    for (const bad of ['ab', 'a-b', 'has space', '😀user']) {
      const { status, json } = await patchProfile(alice, { username: bad });
      assert.equal(status, 422, `should reject ${bad}`);
      assert.ok(json.error?.details?.username, 'field error for username');
    }
  });

  await report.check('username: taken → 409 USERNAME_TAKEN (and profile unchanged)', async () => {
    const before = await me(alice);
    const { status, json } = await patchProfile(alice, { username: 'alex' });
    assert.equal(status, 409);
    assert.equal(json.error?.code, 'USERNAME_TAKEN');
    assert.equal((await me(alice)).username, before.username);
  });

  await report.check('a client-supplied id is IGNORED — session identity decides the owner', async () => {
    const bobBefore = await me(bob);
    // The body claims to be bob (id) and even tries bob's username — the
    // session identity must win: only alice is edited, the username clash is
    // refused, and bob is never touched.
    const steal = await patchProfile(alice, { id: bob.id, username: bob.username });
    assert.equal(steal.status, 409, 'cannot take the victim username either');
    const { status, json } = await patchProfile(alice, { id: bob.id, displayName: 'Hijacker' });
    assert.equal(status, 200);
    assert.equal(json.data?.id, alice.id, 'updated the session user');
    const bobAfter = await me(bob);
    assert.equal(bobAfter.displayName, bobBefore.displayName, 'victim untouched');
    assert.equal(bobAfter.username, bobBefore.username);
    // the alice change DID apply to alice
    assert.equal((await me(alice)).displayName, 'Hijacker');
    await patchProfile(alice, { displayName: 'Profile Tester' });
  });

  await report.check('avatar: image upload (purpose=avatar) → AVATAR attachment with metadata', async () => {
    const up = await uploadAvatar(alice, PNG_BYTES);
    assert.equal(up.status, 200);
    assert.equal(up.data?.kind, 'AVATAR');
    assert.ok(up.data?.url, 'url returned');
  });

  await report.check('avatar: PATCH attaches the uploaded photo (own attachment only)', async () => {
    const up = await uploadAvatar(alice, PNG_BYTES);
    const { status, json } = await patchProfile(alice, { avatarUrl: up.data!.url });
    assert.equal(status, 200);
    assert.equal(json.data?.avatarUrl, up.data!.url);
    assert.equal((await me(alice)).avatarUrl, up.data!.url);
  });

  await report.check('avatar: ANOTHER user\'s photo is rejected (INVALID_AVATAR)', async () => {
    const up = await uploadAvatar(bob, PNG_BYTES);
    assert.equal(up.status, 200);
    const before = await me(alice);
    const { status, json } = await patchProfile(alice, { avatarUrl: up.data!.url });
    assert.equal(status, 422);
    assert.equal(json.error?.code, 'INVALID_AVATAR');
    assert.equal((await me(alice)).avatarUrl, before.avatarUrl, 'profile uncorrupted');
  });

  await report.check('avatar: arbitrary/external URLs are rejected (no free-form URL injection)', async () => {
    for (const bad of ['javascript:alert(1)', 'https://evil.example/tracker.gif', '/api/files/nope.png']) {
      const { status, json } = await patchProfile(alice, { avatarUrl: bad });
      assert.equal(status, 422, `should reject ${bad}`);
      assert.equal(json.error?.code, 'INVALID_AVATAR');
    }
  });

  await report.check('avatar: non-image uploads for purpose=avatar are refused (nothing stored)', async () => {
    const up = await uploadAvatar(alice, WEBM_BYTES, 'video/webm', 'clip.webm');
    assert.equal(up.status, 400);
    assert.equal(up.error?.code, 'UNSUPPORTED_TYPE');
  });

  await report.check('avatar: over the 5MB profile-photo limit is refused', async () => {
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024, 1)]);
    const up = await uploadAvatar(alice, big);
    assert.equal(up.status, 400);
    assert.equal(up.error?.code, 'FILE_TOO_LARGE');
    // the general upload limit for regular files is unchanged (still 25MB)
    // — covered by the voice-upload suites.
  });

  await report.check('avatar: replacing the photo cleans up the previous one', async () => {
    const first = await uploadAvatar(alice, PNG_BYTES);
    assert.equal((await patchProfile(alice, { avatarUrl: first.data!.url })).status, 200);
    const second = await uploadAvatar(alice, PNG_BYTES);
    assert.equal((await patchProfile(alice, { avatarUrl: second.data!.url })).status, 200);
    assert.equal((await me(alice)).avatarUrl, second.data!.url);

    // Old attachment is gone: its URL can no longer be re-attached…
    const { status, json } = await patchProfile(alice, { avatarUrl: first.data!.url });
    assert.equal(status, 422, 'previous avatar row was cleaned up');
    assert.equal(json.error?.code, 'INVALID_AVATAR');
    // …and its stored object is deleted (best-effort cleanup ran).
    const url = first.data!.url.startsWith('http') ? first.data!.url : `${SERVER_URL}${first.data!.url}`;
    const fileRes = await fetch(url, { headers: { Cookie: alice.cookie } }).catch(() => null);
    assert.ok(!fileRes || fileRes.status === 404, `old object should be gone (got ${fileRes?.status})`);
  });

  await report.check('avatar: null removes the photo and cleans up the object', async () => {
    const up = await uploadAvatar(alice, PNG_BYTES);
    assert.equal((await patchProfile(alice, { avatarUrl: up.data!.url })).status, 200);
    const { status, json } = await patchProfile(alice, { avatarUrl: null });
    assert.equal(status, 200);
    assert.equal(json.data?.avatarUrl, null);
    assert.equal((await me(alice)).avatarUrl, null);
    const url = up.data!.url.startsWith('http') ? up.data!.url : `${SERVER_URL}${up.data!.url}`;
    const fileRes = await fetch(url, { headers: { Cookie: alice.cookie } }).catch(() => null);
    assert.ok(!fileRes || fileRes.status === 404, 'removed photo object deleted');
  });

  await report.check('profile view: GET /api/users/[username] reflects the saved profile', async () => {
    await patchProfile(alice, { displayName: 'Final Name', about: 'Final about text.' });
    await sleep(50);
    const current = await me(alice); // username may have changed earlier in this suite
    const res = await fetch(`${SERVER_URL}/api/users/${current.username}`, { headers: { Cookie: alice.cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; data?: { displayName: string; about: string } };
    assert.equal(body.data?.displayName, 'Final Name');
    assert.equal(body.data?.about, 'Final about text.');
  });

  await report.check('failed saves never corrupt the profile (aggregate sanity)', async () => {
    const before = await me(alice);
    await patchProfile(alice, { displayName: 'X' }); // too short
    await patchProfile(alice, { username: '!!' }); // invalid
    await patchProfile(alice, { avatarUrl: 'https://evil.example/x.png' }); // foreign
    await patchProfile(alice, { about: 'X'.repeat(141) }); // too long
    const after = await me(alice);
    assert.equal(after.displayName, before.displayName);
    assert.equal(after.username, before.username);
    assert.equal(after.avatarUrl, before.avatarUrl);
    assert.equal(after.about, before.about);
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
