/**
 * Message alignment (isMine) — end-to-end test against a running server.
 *
 * Two real users in a group and in a 1:1 chat receive the same broadcast
 * MESSAGE_NEW / MESSAGE_UPDATED payloads; each client's resolution must place
 * the bubble on the right for the sender and on the left for everyone else.
 *
 * Run: SERVER_URL=http://localhost:3300 npm run test:messages:e2e
 *      (requires a running server + seeded users alex/emma, password linkup123)
 */
import assert from 'node:assert/strict';
import { EVENTS } from '../shared/events';
import { resolveMessageForViewer } from '../src/lib/message-view';
import type { MessageDTO } from '../src/types';
import {
  api,
  connectSocket,
  createReporter,
  login,
  sleep,
  uniq,
  waitFor,
  type Session
} from './helpers';

const { check, finish } = createReporter();

/** What a client stores/displays: the wire payload resolved for its viewer. */
function asStored(wire: MessageDTO, viewerId: string): MessageDTO {
  return resolveMessageForViewer(wire, viewerId);
}

async function main() {
  console.log('\n■ Users');
  const alex = await login('alex');
  const emma = await login('emma');
  assert.ok(alex.id && emma.id, 'both users resolved');
  console.log(`■ Users: alex=${alex.id} emma=${emma.id}`);

  // Group with both members
  const groupRes = await api<{ data?: { conversation?: { id: string } }; conversation?: { id: string } }>(
    alex,
    'POST',
    '/api/conversations',
    { type: 'GROUP', title: `Alignment QA ${uniq()}`, memberIds: [alex.id, emma.id] }
  );
  const groupId = groupRes.json.data?.conversation?.id ?? groupRes.json.conversation?.id;
  assert.ok(groupId, `group created (HTTP ${groupRes.status})`);

  // 1:1 between them (upsert by directKey — idempotent)
  const directRes = await api<{ data?: { conversation?: { id: string } }; conversation?: { id: string } }>(
    alex,
    'POST',
    '/api/conversations',
    { type: 'DIRECT', username: 'emma' }
  );
  const directId = directRes.json.data?.conversation?.id ?? directRes.json.conversation?.id;
  assert.ok(directId, `direct conversation ready (HTTP ${directRes.status})`);

  // Sockets AFTER conversations exist → auto-join membership rooms on connect.
  const sockAlex = connectSocket(alex);
  const sockEmma = connectSocket(emma);
  await Promise.all([
    new Promise<void>((res, rej) => {
      sockAlex.once('connect', () => res());
      sockAlex.once('connect_error', rej);
    }),
    new Promise<void>((res, rej) => {
      sockEmma.once('connect', () => res());
      sockEmma.once('connect_error', rej);
    })
  ]);
  // Belt & braces for any membership granted after connect.
  for (const sock of [sockAlex, sockEmma]) {
    sock.emit('conversation:join', { conversationId: groupId });
    sock.emit('conversation:join', { conversationId: directId });
  }
  // Record every received broadcast so checks can compare the same message
  // as seen by two different viewers.
  const lastPayloads = new Map<string, MessageDTO>();
  sockAlex.on(EVENTS.MESSAGE_NEW, (p: MessageDTO) => lastPayloads.set('alex', p));
  sockEmma.on(EVENTS.MESSAGE_NEW, (p: MessageDTO) => lastPayloads.set('emma', p));
  await sleep(300);

  // ── Group: alex sends ──
  await check('group sender sees their own message on the right (isMine=true)', async () => {
    const [wireAtA, wireAtE] = await Promise.all([
      waitFor<MessageDTO>(sockAlex, EVENTS.MESSAGE_NEW),
      waitFor<MessageDTO>(sockEmma, EVENTS.MESSAGE_NEW),
      api(alex, 'POST', `/api/conversations/${groupId}/messages`, {
        type: 'TEXT',
        content: 'group-hi-from-alex',
        clientNonce: `e2e-${uniq()}-g1`
      })
    ]).then((r) => [r[0], r[1]] as const);

    assert.equal(wireAtA.senderId, alex.id, 'senderId must be the actual sender');
    assert.equal(wireAtE.senderId, alex.id, 'senderId must be the actual sender');

    const mineAtA = asStored(wireAtA, alex.id);
    assert.equal(mineAtA.isMine, true, 'sender must see it on the right');
  });

  await check('another group member sees that same message on the left (isMine=false)', async () => {
    // The SAME alex message as Emma's client stores it — her socket's copy
    // resolved against her user id.
    const lastWireEmma = lastPayloads.get('emma');
    assert.ok(lastWireEmma, 'emma received the message');
    assert.equal(lastWireEmma.senderId, alex.id);
    assert.equal(asStored(lastWireEmma, emma.id).isMine, false, 'peer must see it on the left');
  });

  await check("messages sent by the other member appear on the first user's left (isMine=false)", async () => {
    const [wireAtA, wireAtE] = await Promise.all([
      waitFor<MessageDTO>(sockAlex, EVENTS.MESSAGE_NEW),
      waitFor<MessageDTO>(sockEmma, EVENTS.MESSAGE_NEW),
      api(emma, 'POST', `/api/conversations/${groupId}/messages`, {
        type: 'TEXT',
        content: 'group-hi-from-emma',
        clientNonce: `e2e-${uniq()}-g2`
      })
    ]).then((r) => [r[0], r[1]] as const);

    assert.equal(wireAtA.senderId, emma.id, 'senderId must be the actual sender');
    assert.equal(asStored(wireAtA, alex.id).isMine, false, "peer's message lands on my left");
    assert.equal(asStored(wireAtE, emma.id).isMine, true, 'sender sees her own on the right');
  });

  await check('1:1 alignment still works (both directions)', async () => {
    const [wireAtA, wireAtE] = await Promise.all([
      waitFor<MessageDTO>(sockAlex, EVENTS.MESSAGE_NEW),
      waitFor<MessageDTO>(sockEmma, EVENTS.MESSAGE_NEW),
      api(alex, 'POST', `/api/conversations/${directId}/messages`, {
        type: 'TEXT',
        content: 'dm-hi-from-alex',
        clientNonce: `e2e-${uniq()}-d1`
      })
    ]).then((r) => [r[0], r[1]] as const);

    assert.equal(wireAtA.senderId, alex.id);
    assert.equal(asStored(wireAtA, alex.id).isMine, true, '1:1: my message on my right');
    assert.equal(asStored(wireAtE, emma.id).isMine, false, '1:1: my message on their left');

    const [wireAtA2, wireAtE2] = await Promise.all([
      waitFor<MessageDTO>(sockAlex, EVENTS.MESSAGE_NEW),
      waitFor<MessageDTO>(sockEmma, EVENTS.MESSAGE_NEW),
      api(emma, 'POST', `/api/conversations/${directId}/messages`, {
        type: 'TEXT',
        content: 'dm-hi-from-emma',
        clientNonce: `e2e-${uniq()}-d2`
      })
    ]).then((r) => [r[0], r[1]] as const);

    assert.equal(asStored(wireAtA2, alex.id).isMine, false, '1:1: their message on my left');
    assert.equal(asStored(wireAtE2, emma.id).isMine, true, '1:1: their message on their right');
  });

  await check('message:updated broadcasts stay aligned for the receiving viewer', async () => {
    const nonce = `e2e-${uniq()}-ed`;
    const [createdAtA] = await Promise.all([
      waitFor<MessageDTO>(sockAlex, EVENTS.MESSAGE_NEW),
      waitFor<MessageDTO>(sockEmma, EVENTS.MESSAGE_NEW),
      api(alex, 'POST', `/api/conversations/${groupId}/messages`, {
        type: 'TEXT',
        content: 'edit-me',
        clientNonce: nonce
      })
    ]).then((r) => [r[0]] as const);

    const messageId = createdAtA.id;
    const [wireAtA, wireAtE] = await Promise.all([
      waitFor<MessageDTO>(sockAlex, EVENTS.MESSAGE_UPDATED),
      waitFor<MessageDTO>(sockEmma, EVENTS.MESSAGE_UPDATED),
      api(alex, 'PATCH', `/api/messages/${messageId}`, { content: 'edit-me-please' })
    ]).then((r) => [r[0], r[1]] as const);

    assert.equal(wireAtE.senderId, alex.id, 'senderId must be the actual sender');
    assert.equal(wireAtE.content, 'edit-me-please');
    assert.equal(asStored(wireAtA, alex.id).isMine, true, 'editor keeps it on the right');
    assert.equal(asStored(wireAtE, emma.id).isMine, false, 'receiver keeps it on the left');
  });

  await check('history is viewer-aligned the same way as live messages', async () => {
    const [forA, forE] = await Promise.all([
      api<{ data?: { messages?: MessageDTO[] } }>(alex, 'GET', `/api/conversations/${groupId}/messages?limit=20`),
      api<{ data?: { messages?: MessageDTO[] } }>(emma, 'GET', `/api/conversations/${groupId}/messages?limit=20`)
    ]);
    const listA = forA.json.data?.messages ?? [];
    const listE = forE.json.data?.messages ?? [];
    for (const m of listA) {
      assert.equal(
        m.isMine,
        m.senderId === alex.id,
        `history isMine wrong for alex on ${m.id} (sender ${m.senderId})`
      );
    }
    for (const m of listE) {
      assert.equal(
        m.isMine,
        m.senderId === emma.id,
        `history isMine wrong for emma on ${m.id} (sender ${m.senderId})`
      );
    }
  });

  sockAlex.disconnect();
  sockEmma.disconnect();
  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
