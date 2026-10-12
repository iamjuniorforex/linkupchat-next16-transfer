/**
 * Message alignment (isMine) — unit tests for the client-side viewer
 * resolution that every client applies to realtime broadcast payloads.
 *
 * Run: npm run test:messages   (tsx tests/message-alignment.test.ts)
 */
import assert from 'node:assert/strict';
import { resolveMessageForViewer } from '../src/lib/message-view';
import type { MessageDTO } from '../src/types';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
}

/** The exact shape a room broadcast carries: serialized ONCE against the
 * sender's id, so `isMine` arrives true for every recipient. */
function broadcastFrom(senderId: string, conversationId: string, id: string): MessageDTO {
  return {
    id,
    conversationId,
    senderId,
    sender: { id: senderId, username: 'sender', displayName: 'Sender', avatarUrl: null },
    type: 'TEXT',
    content: 'hello',
    clientNonce: null,
    replyToId: null,
    replyTo: null,
    attachments: [],
    reactions: [],
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    createdAt: '2026-09-27T12:00:00.000Z',
    updatedAt: '2026-09-27T12:00:00.000Z',
    status: 'SENT',
    readBy: [],
    isMine: true // sender's perspective — what the server puts on the wire
  };
}

const ALEX = 'user-alex';
const EMMA = 'user-emma';
const GROUP = 'conv-group';
const DIRECT = 'conv-direct';

console.log('\n■ Group alignment');

check('group sender sees their own message on the right (isMine=true)', () => {
  const wire = broadcastFrom(ALEX, GROUP, 'm1');
  const seen = resolveMessageForViewer(wire, ALEX);
  assert.equal(seen.isMine, true);
  assert.equal(seen.senderId, ALEX, 'senderId must stay the actual sender');
});

check('another group member sees that same message on the left (isMine=false)', () => {
  const wire = broadcastFrom(ALEX, GROUP, 'm1');
  const seen = resolveMessageForViewer(wire, EMMA);
  assert.equal(seen.isMine, false);
  assert.equal(seen.senderId, ALEX, 'senderId must stay the actual sender');
});

check("messages sent by the other member appear on the first user's left (isMine=false)", () => {
  const wire = broadcastFrom(EMMA, GROUP, 'm2');
  const seen = resolveMessageForViewer(wire, ALEX);
  assert.equal(seen.isMine, false);
  assert.equal(seen.senderId, EMMA, 'senderId must stay the actual sender');
});

check('and the sender of that message sees it on their right (isMine=true)', () => {
  const wire = broadcastFrom(EMMA, GROUP, 'm2');
  const seen = resolveMessageForViewer(wire, EMMA);
  assert.equal(seen.isMine, true);
});

console.log('\n■ 1:1 alignment');

check('1:1: my sent message stays on my right', () => {
  const wire = broadcastFrom(ALEX, DIRECT, 'd1');
  assert.equal(resolveMessageForViewer(wire, ALEX).isMine, true);
});

check('1:1: the peer sees my message on their left', () => {
  const wire = broadcastFrom(ALEX, DIRECT, 'd1');
  assert.equal(resolveMessageForViewer(wire, EMMA).isMine, false);
});

check('1:1: peer messages land on my left, their right', () => {
  const wire = broadcastFrom(EMMA, DIRECT, 'd2');
  assert.equal(resolveMessageForViewer(wire, ALEX).isMine, false);
  assert.equal(resolveMessageForViewer(wire, EMMA).isMine, true);
});

console.log('\n■ Edited / forwarded payloads (message:updated, forwarded message:new)');

check('an edited broadcast keeps receiver alignment (isMine re-derived)', () => {
  // Edits re-broadcast the full DTO from the editor's perspective.
  const wire = { ...broadcastFrom(ALEX, GROUP, 'm1'), content: 'hello (edited)', editedAt: '2026-09-27T12:05:00.000Z' };
  assert.equal(resolveMessageForViewer(wire, ALEX).isMine, true);
  assert.equal(resolveMessageForViewer(wire, EMMA).isMine, false);
  assert.equal(resolveMessageForViewer(wire, EMMA).senderId, ALEX);
});

check('a forwarded broadcast is mine only for the forwarder', () => {
  const wire = broadcastFrom(EMMA, GROUP, 'f1'); // Emma forwarded it
  assert.equal(resolveMessageForViewer(wire, EMMA).isMine, true);
  assert.equal(resolveMessageForViewer(wire, ALEX).isMine, false);
});

console.log('\n■ Degenerate viewers');

check('missing viewer id resolves isMine to false, never true', () => {
  const wire = broadcastFrom(ALEX, GROUP, 'm1');
  assert.equal(resolveMessageForViewer(wire, null).isMine, false);
  assert.equal(resolveMessageForViewer(wire, undefined).isMine, false);
  assert.equal(resolveMessageForViewer(wire, '').isMine, false);
});

check('does not mutate the original payload', () => {
  const wire = broadcastFrom(ALEX, GROUP, 'm1');
  resolveMessageForViewer(wire, EMMA);
  assert.equal(wire.isMine, true);
  assert.equal(wire.senderId, ALEX);
});

console.log('\n════════════════════════════════════');
console.log(`PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
