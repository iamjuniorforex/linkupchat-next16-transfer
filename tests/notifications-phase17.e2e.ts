/**
 * Phase 17 — server-enforced notification preferences, mute, and mentions.
 * Requires the app server (SERVER_URL, default http://localhost:3300).
 *
 * Run: npm run test:notifications:phase17:e2e
 */
import assert from 'node:assert/strict';
import { api, login, type Session } from './helpers';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';

async function register(username: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: username,
      username,
      password: 'linkup123',
      email: `${username}@ex.test`
    })
  });
  if (!res.ok) throw new Error(`register ${username} failed: HTTP ${res.status}`);
  return login(username, 'linkup123');
}

async function noteCount(s: Session): Promise<number> {
  const res = await api<{ data?: { notifications?: unknown[]; unreadCount?: number } }>(s, 'GET', '/api/notifications');
  assert.equal(res.status, 200);
  return res.json.data?.notifications?.length ?? -1;
}

async function send(s: Session, conversationId: string, text: string) {
  const res = await api(s, 'POST', `/api/conversations/${conversationId}/messages`, {
    type: 'TEXT',
    content: text,
    clientNonce: `p17-${Date.now()}-${Math.random().toString(36).slice(2)}`
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
}

async function main() {
  const stamp = Date.now().toString(36);
  const ada = await register(`p17a${stamp}`.slice(0, 24));
  const ben = await register(`p17b${stamp}`.slice(0, 24));
  const cy = await register(`p17c${stamp}`.slice(0, 24));

  const settings = await api<{ data?: { notifEnabled?: boolean; notifStatus?: boolean } }>(
    ben,
    'PATCH',
    '/api/users/me/settings',
    { notifEnabled: false, notifStatus: false }
  );
  assert.equal(settings.status, 200);
  assert.equal(settings.json.data?.notifEnabled, false);
  assert.equal(settings.json.data?.notifStatus, false);

  const direct = await api<{ data?: { conversation?: { id?: string }; id?: string } }>(
    ada,
    'POST',
    '/api/conversations',
    { type: 'DIRECT', username: ben.username }
  );
  const directId = direct.json.data?.conversation?.id ?? direct.json.data?.id ?? '';
  assert.ok(directId, 'direct conversation created');

  const beforeOff = await noteCount(ben);
  await send(ada, directId, 'should not notify');
  assert.equal(await noteCount(ben), beforeOff, 'master off must not create a notification');
  assert.equal(await noteCount(ada), 0, 'sender must not be notified');

  await api(ben, 'PATCH', '/api/users/me/settings', { notifEnabled: true, notifMessages: false });
  await send(ada, directId, 'category off');
  assert.equal(await noteCount(ben), beforeOff, 'notifMessages off must not create a DM notification');

  await api(ben, 'PATCH', '/api/users/me/settings', { notifMessages: true, notifPreview: false });
  await send(ada, directId, 'secret preview text');
  const feed = await api<{ data?: { notifications?: { body: string | null; title: string }[] } }>(
    ben,
    'GET',
    '/api/notifications'
  );
  const row = feed.json.data?.notifications?.[0];
  assert.ok(row, 'enabled recipient gets one notification');
  assert.equal(row?.body?.includes('secret preview text'), false);
  assert.equal(await noteCount(ada), 0, 'sender still has no notification');

  const group = await api<{ data?: { conversation?: { id?: string }; id?: string } }>(
    ada,
    'POST',
    '/api/conversations',
    { type: 'GROUP', memberIds: [ben.id, cy.id], title: `P17 ${stamp.slice(-4)}` }
  );
  const groupId = group.json.data?.conversation?.id ?? group.json.data?.id ?? '';
  assert.ok(groupId, 'group created');

  const muted = await api(ben, 'POST', `/api/conversations/${groupId}/mute`, { muted: true });
  assert.equal(muted.status, 200);
  const mutedBefore = await noteCount(ben);
  await send(ada, groupId, 'ordinary group text');
  assert.equal(await noteCount(ben), mutedBefore, 'muted group must not notify');

  await send(ada, groupId, `hey @${ben.username} look`);
  const mentioned = await api<{
    data?: { notifications?: { title: string; data?: { mention?: boolean } | null }[] };
  }>(ben, 'GET', '/api/notifications');
  const mention = mentioned.json.data?.notifications?.find((n) => n.data?.mention === true);
  assert.ok(mention, 'mention bypasses mute');
  assert.match(mention?.title ?? '', /mentioned you/);

  const marked = await api<{ data?: { updated?: number; unread?: number } }>(ben, 'PATCH', '/api/notifications', {
    all: true
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.json.data?.unread, 0, 'mark-all returns a persisted unread count');

  console.log('phase17 notification e2e passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
