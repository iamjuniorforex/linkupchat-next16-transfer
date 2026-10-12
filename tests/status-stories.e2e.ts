/**
 * Phase 15 — status audience, reactions, replies, archive, and viewer privacy.
 * HTTP against the running server. Run: SERVER_URL=http://127.0.0.1:3300 tsx tests/status-stories.e2e.ts
 */
import assert from 'node:assert/strict';
import { SERVER_URL, api, createReporter, login, type Session } from './helpers';
import { db } from '../src/lib/db';

const report = createReporter();

async function register(username: string, displayName: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Passw0rd123',
      displayName,
      email: `${username}@example.com`
    })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function postText(s: Session, content: string, extra: Record<string, unknown> = {}) {
  return api<{
    ok?: boolean;
    data?: { status?: { id: string } };
    error?: { message?: string };
  }>(s, 'POST', '/api/status', { type: 'TEXT', content, ...extra });
}

async function feedIds(s: Session): Promise<string[]> {
  const res = await api<{ data?: { groups?: { statuses?: { id: string }[] }[] } }>(s, 'GET', '/api/status');
  assert.equal(res.status, 200);
  return (res.json.data?.groups ?? []).flatMap((g) => (g.statuses ?? []).map((x) => x.id));
}

async function main() {
  console.log('■ status-stories: audience, reactions, replies, archive');
  const stamp = Date.now().toString(36);
  const author = await register(`p15a_${stamp}`, 'Author Ada');
  const pal = await register(`p15b_${stamp}`, 'Pal Bea');
  const skip = await register(`p15c_${stamp}`, 'Skip Cam');
  const stranger = await register(`p15d_${stamp}`, 'Stranger Dee');

  assert.equal((await api(author, 'POST', '/api/contacts', { userId: pal.id })).status, 201);
  assert.equal((await api(author, 'POST', '/api/contacts', { userId: skip.id })).status, 201);
  assert.equal((await api(pal, 'POST', '/api/contacts', { userId: author.id })).status, 201);
  assert.equal((await api(skip, 'POST', '/api/contacts', { userId: author.id })).status, 201);

  let openId = '';
  let exceptId = '';
  let onlyId = '';

  await report.check('default contacts audience is visible to a contact and hidden from a stranger', async () => {
    const res = await postText(author, `open ${stamp}`);
    assert.equal(res.status, 201, JSON.stringify(res.json.error ?? {}));
    openId = res.json.data!.status!.id;
    assert.ok((await feedIds(pal)).includes(openId));
    assert.ok(!(await feedIds(stranger)).includes(openId));
    const hidden = await api(stranger, 'POST', `/api/status/${openId}/view`);
    assert.equal(hidden.status, 404);
    const viewers = await api(stranger, 'GET', `/api/status/${openId}`);
    assert.equal(viewers.status, 404);
  });

  await report.check('contacts-except hides the listed contact from feed, view, and media metadata', async () => {
    const res = await postText(author, `except ${stamp}`, {
      audience: 'CONTACTS_EXCEPT',
      audienceUserIds: [skip.id]
    });
    assert.equal(res.status, 201, JSON.stringify(res.json.error ?? {}));
    exceptId = res.json.data!.status!.id;
    assert.ok((await feedIds(pal)).includes(exceptId));
    assert.ok(!(await feedIds(skip)).includes(exceptId));
    assert.equal((await api(skip, 'POST', `/api/status/${exceptId}/view`)).status, 404);
    assert.equal((await api(skip, 'GET', `/api/status/${exceptId}`)).status, 404);
  });

  await report.check('only-share shows the listed contact and hides the other contact', async () => {
    const res = await postText(author, `only ${stamp}`, {
      audience: 'ONLY_SHARE',
      audienceUserIds: [pal.id]
    });
    assert.equal(res.status, 201, JSON.stringify(res.json.error ?? {}));
    onlyId = res.json.data!.status!.id;
    assert.ok((await feedIds(pal)).includes(onlyId));
    assert.ok(!(await feedIds(skip)).includes(onlyId));
    assert.equal((await api(skip, 'POST', `/api/status/${onlyId}/react`, { emoji: '🔥' })).status, 404);
  });

  await report.check('an audience list that is not a contact is rejected', async () => {
    const res = await postText(author, `bad audience ${stamp}`, {
      audience: 'ONLY_SHARE',
      audienceUserIds: [stranger.id]
    });
    assert.equal(res.status, 422);
  });

  await report.check('one reaction per viewer; the same emoji clears it; viewers stay author-only', async () => {
    const first = await api<{ data?: { emoji?: string | null } }>(pal, 'POST', `/api/status/${openId}/react`, {
      emoji: '❤️'
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.data?.emoji, '❤️');
    const again = await api<{ data?: { emoji?: string | null } }>(pal, 'POST', `/api/status/${openId}/react`, {
      emoji: '❤️'
    });
    assert.equal(again.json.data?.emoji, null);
    const replaced = await api<{ data?: { emoji?: string | null } }>(pal, 'POST', `/api/status/${openId}/react`, {
      emoji: '🔥'
    });
    assert.equal(replaced.json.data?.emoji, '🔥');
    const rows = await db.statusReaction.count({ where: { statusId: openId, userId: pal.id } });
    assert.equal(rows, 1);
    assert.equal((await api(pal, 'POST', `/api/status/${openId}/view`)).status, 200);
    const owner = await api<{ data?: { status?: { viewerCount?: number; viewers?: { id: string }[] } } }>(
      author,
      'GET',
      `/api/status/${openId}`
    );
    assert.equal(owner.status, 200);
    assert.equal(owner.json.data?.status?.viewerCount, 1);
    assert.deepEqual(owner.json.data?.status?.viewers?.map((v) => v.id), [pal.id]);
    assert.equal((await api(pal, 'GET', `/api/status/${openId}`)).status, 404);
  });

  await report.check('a reply is one direct message with attribution, and a retry does not duplicate it', async () => {
    const nonce = `reply-${stamp}-nonce`;
    const first = await api<{
      data?: { conversationId?: string; message?: { id: string; content?: string } };
    }>(pal, 'POST', `/api/status/${openId}/reply`, { text: 'Nice update', clientNonce: nonce });
    assert.equal(first.status, 201, JSON.stringify(first));
    assert.match(first.json.data?.message?.content ?? '', /text status/);
    assert.match(first.json.data?.message?.content ?? '', /Nice update/);
    const second = await api<{ data?: { duplicate?: boolean; message?: { id: string } } }>(
      pal,
      'POST',
      `/api/status/${openId}/reply`,
      { text: 'Nice update', clientNonce: nonce }
    );
    assert.equal(second.json.data?.duplicate, true);
    assert.equal(second.json.data?.message?.id, first.json.data?.message?.id);
    const count = await db.message.count({
      where: { conversationId: first.json.data!.conversationId, content: { contains: 'Nice update' } }
    });
    assert.equal(count, 1);
    assert.equal((await api(author, 'POST', `/api/status/${openId}/reply`, { text: 'nope' })).status, 422);
  });

  await report.check('archive hides the status from feeds and keeps it in the author archive only', async () => {
    const archived = await api(author, 'POST', `/api/status/${exceptId}/archive`);
    assert.equal(archived.status, 200);
    assert.ok(!(await feedIds(pal)).includes(exceptId));
    const mine = await api<{ data?: { statuses?: { id: string }[] } }>(author, 'GET', '/api/status/me');
    assert.ok(!(mine.json.data?.statuses ?? []).some((s) => s.id === exceptId));
    const archive = await api<{ data?: { statuses?: { id: string }[] } }>(author, 'GET', '/api/status/archive');
    assert.equal(archive.status, 200);
    assert.ok((archive.json.data?.statuses ?? []).some((s) => s.id === exceptId));
    const other = await api<{ data?: { statuses?: { id: string }[] } }>(pal, 'GET', '/api/status/archive');
    assert.ok(!(other.json.data?.statuses ?? []).some((s) => s.id === exceptId));
    assert.equal((await api(pal, 'POST', `/api/status/${exceptId}/view`)).status, 404);
  });

  await report.check('an expired status leaves the active feed and stays in the author archive', async () => {
    await db.status.update({
      where: { id: onlyId },
      data: { expiresAt: new Date(Date.now() - 60_000) }
    });
    assert.ok(!(await feedIds(pal)).includes(onlyId));
    const archive = await api<{ data?: { statuses?: { id: string }[] } }>(author, 'GET', '/api/status/archive');
    assert.ok((archive.json.data?.statuses ?? []).some((s) => s.id === onlyId));
    assert.equal((await api(pal, 'POST', `/api/status/${onlyId}/react`, { emoji: '😂' })).status, 404);
  });

  await report.check('a non-owner still cannot delete (403)', async () => {
    const del = await api(pal, 'DELETE', `/api/status/${openId}`);
    assert.equal(del.status, 403);
  });

  await report.check('status notifications collapse, hide previews when asked, and do not duplicate reactions', async () => {
    const palNotes = await api<{
      data?: { notifications?: { id: string; type: string; body: string | null; data?: { kind?: string; count?: number } | null }[] };
    }>(pal, 'GET', '/api/notifications');
    const updates = (palNotes.json.data?.notifications ?? []).filter((n) => n.data?.kind === 'status-update');
    assert.equal(updates.length, 1, `expected one collapsed status update, got ${updates.length}`);
    assert.ok((updates[0]?.data?.count ?? 0) >= 2, 'repeated statuses should raise the count');

    await db.userSettings.update({ where: { userId: author.id }, data: { notifPreview: false } });
    const quiet = await postText(author, `secret caption ${stamp}`);
    assert.equal(quiet.status, 201);
    const reacted = await api(pal, 'POST', `/api/status/${quiet.json.data!.status!.id}/react`, { emoji: '😂' });
    assert.equal(reacted.status, 200);
    const authorNotes = await api<{
      data?: { notifications?: { id: string; type: string; title?: string; body: string | null; data?: { kind?: string } | null }[] };
    }>(author, 'GET', '/api/notifications');
    const quietReaction = (authorNotes.json.data?.notifications ?? []).find(
      (n) => n.data?.kind === 'status-reaction' && (n.title ?? '').includes('😂')
    );
    assert.ok(quietReaction, 'expected a reaction notification');
    assert.equal((quietReaction?.body ?? '').includes('secret caption'), false);
    const replyNotes = (authorNotes.json.data?.notifications ?? []).filter((n) => n.data?.kind === 'status-reply');
    assert.equal(replyNotes.length, 1);

    await db.userSettings.update({ where: { userId: skip.id }, data: { notifStatus: false } });
    const before = await db.notification.count({ where: { userId: skip.id, type: 'SYSTEM' } });
    const again = await postText(author, `muted ${stamp}`);
    assert.equal(again.status, 201);
    const after = await db.notification.count({ where: { userId: skip.id, type: 'SYSTEM' } });
    assert.equal(after, before, 'notifStatus=false must skip the status update');
  });

  await db.$disconnect();
  report.finish();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
