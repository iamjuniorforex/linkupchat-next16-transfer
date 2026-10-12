/**
 * Phase 16 — profile privacy, phone search, contacts, and discovery.
 * Run: SERVER_URL=http://127.0.0.1:3300 tsx tests/profile-privacy.e2e.ts
 */
import assert from 'node:assert/strict';
import { SERVER_URL, api, createReporter, login, type Session } from './helpers';
import { db } from '../src/lib/db';

const report = createReporter();

async function register(username: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Passw0rd123',
      displayName: `P16 ${username}`,
      email: `${username}@example.com`,
      ...extra
    })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function searchIds(s: Session, q: string): Promise<string[]> {
  const res = await api<{ data?: { users?: { id: string; phone?: string }[] } }>(
    s,
    'GET',
    `/api/users/search?q=${encodeURIComponent(q)}`
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(!(res.json.data?.users ?? []).some((u) => 'phone' in (u as object) && u.phone), 'phone leaked');
  return (res.json.data?.users ?? []).map((u) => u.id);
}

async function main() {
  console.log('■ profile-privacy: phone search, contacts, username, discovery');
  const stamp = Date.now().toString(36);
  const phone = `+23324${String(Date.now()).slice(-7)}`;
  const owner = await register(`p16o_${stamp}`, { phone });
  const pal = await register(`p16p_${stamp}`);
  const stranger = await register(`p16s_${stamp}`);

  await report.check('a phone fragment never finds an account', async () => {
    const ids = await searchIds(stranger, phone.slice(0, 6));
    assert.ok(!ids.includes(owner.id));
  });

  await report.check('a full phone number is hidden until the owner allows phone search', async () => {
    assert.ok(!(await searchIds(stranger, phone)).includes(owner.id));
    const opened = await api(owner, 'PATCH', '/api/users/me/settings', { privacyPhoneSearch: 'EVERYONE' });
    assert.equal(opened.status, 200);
    assert.ok((await searchIds(stranger, phone)).includes(owner.id));
    const formatted = await searchIds(stranger, phone.replace('+233', '+233 '));
    assert.ok(formatted.includes(owner.id), 'formatting differences still exact-match');
  });

  await report.check('reserved usernames are rejected and the first rename still works', async () => {
    const reserved = await api(pal, 'PATCH', '/api/users/me', { username: 'support' });
    assert.equal(reserved.status, 422);
    const next = `p16n_${stamp}`.slice(0, 24);
    const renamed = await api<{ data?: { username?: string } }>(pal, 'PATCH', '/api/users/me', { username: next });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    assert.equal(renamed.json.data?.username, next);
    const again = await api(pal, 'PATCH', '/api/users/me', { username: `p16x_${stamp}`.slice(0, 24) });
    assert.equal(again.status, 422);
  });

  await report.check('contact permission and blocks are enforced on the server', async () => {
    const closed = await api(owner, 'PATCH', '/api/users/me/settings', { privacyAddMe: 'NOBODY' });
    assert.equal(closed.status, 200);
    const denied = await api(stranger, 'POST', '/api/contacts', { userId: owner.id });
    assert.equal(denied.status, 403);
    await api(owner, 'PATCH', '/api/users/me/settings', { privacyAddMe: 'EVERYONE' });
    const added = await api(stranger, 'POST', '/api/contacts', { userId: owner.id });
    assert.equal(added.status, 201);
    const me = await api<{ data?: { username?: string } }>(owner, 'GET', '/api/auth/me');
    const blocked = await api(stranger, 'POST', `/api/users/${me.json.data!.username}/block`, { blocked: true });
    assert.equal(blocked.status, 200);
    const list = await api<{ data?: { contacts?: { user: { id: string } }[] } }>(stranger, 'GET', '/api/contacts');
    assert.ok(!(list.json.data?.contacts ?? []).some((c) => c.user.id === owner.id));
    const readd = await api(stranger, 'POST', '/api/contacts', { userId: owner.id });
    assert.equal(readd.status, 403);
  });

  await report.check('discovery returns no phone numbers and honors opt-out', async () => {
    const ownerMe = await api<{ data?: { username?: string } }>(owner, 'GET', '/api/auth/me');
    await api(stranger, 'POST', `/api/users/${ownerMe.json.data!.username}/block`, { blocked: false });
    await api(stranger, 'POST', '/api/contacts', { userId: pal.id });
    await api(pal, 'POST', '/api/contacts', { userId: owner.id });
    const hidden = await api(owner, 'PATCH', '/api/users/me/settings', { privacyDiscover: 'NOBODY' });
    assert.equal(hidden.status, 200);
    const discover = await api<{ data?: { users?: { id: string; phone?: string }[] } }>(stranger, 'GET', '/api/users/discover');
    assert.equal(discover.status, 200);
    assert.ok(!(discover.json.data?.users ?? []).some((u) => u.id === owner.id));
    assert.ok(!(discover.json.data?.users ?? []).some((u) => u.phone));
  });

  await db.$disconnect();
  report.finish();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
