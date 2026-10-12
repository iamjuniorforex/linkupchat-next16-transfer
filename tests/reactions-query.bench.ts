/**
 * Reaction/reply rendering query benchmark (Part I — N+1 guard).
 *
 * Verifies that loading a page of messages WITH reactions and reply quotes
 * uses a CONSTANT number of queries (Prisma relation batching), never one
 * query per message. Reactions must render without a query explosion in
 * busy group conversations.
 *
 * Run: DATABASE_URL=postgresql://… npm run bench:reactions
 */
import { PrismaClient } from '@prisma/client';
import { messageInclude } from '../src/lib/serialize';

const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

type LogEvt = { query: string };
const queryLog: LogEvt[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(db as any).$on('query', (e: LogEvt) => queryLog.push(e));

const MESSAGE_COUNT = 30;
const QUERY_BOUND = 12; // constant budget: messages + sender + reactions + replyTo + attachments…

async function main() {
  const tag = `bench-${Date.now().toString(36)}`;

  // Scratch users + a busy conversation: 30 messages, replies, multi-user reactions.
  const users = await Promise.all(
    ['a', 'b', 'c'].map((k) =>
      db.user.create({
        data: {
          username: `${tag}-${k}`,
          displayName: `Bench ${k}`,
          email: `${tag}-${k}@bench.local`,
          passwordHash: 'x'
        }
      })
    )
  );
  const conv = await db.conversation.create({
    data: {
      type: 'DIRECT',
      members: { create: users.map((u) => ({ userId: u.id })) }
    }
  });

  const created = await db.$transaction(
    Array.from({ length: MESSAGE_COUNT }, (_, i) =>
      db.message.create({
        data: {
          conversationId: conv.id,
          senderId: users[i % users.length]!.id,
          type: 'TEXT',
          content: `bench message ${i}`
        }
      })
    )
  );

  // Wire every 3rd message as a reply to the one before it.
  await db.$transaction(
    created.flatMap((m, i) =>
      i >= 3 && i % 3 === 0
        ? [db.message.update({ where: { id: m.id }, data: { replyToId: created[i - 1]!.id } })]
        : []
    )
  );

  // Reactions from all three users on most messages.
  await db.$transaction(
    created.flatMap((m, i) =>
      i % 2 === 0
        ? users.map((u, ui) =>
            db.messageReaction.create({
              data: { messageId: m.id, userId: u.id, emoji: ['👍', '❤️', '🙏'][ui]! }
            })
          )
        : []
    )
  );

  // ── Measure the exact query path used by GET message history ──
  queryLog.length = 0;
  const t0 = process.hrtime.bigint();
  const rows = await db.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: 'desc' },
    take: MESSAGE_COUNT,
    include: messageInclude
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const withReactions = rows.filter((r) => (r.reactions?.length ?? 0) > 0).length;
  const withReplies = rows.filter((r) => r.replyTo).length;
  console.log(`\n■ History page: ${rows.length} messages (${withReactions} with reactions, ${withReplies} with replies)`);
  console.log(`  queries: ${queryLog.length}  time: ${ms.toFixed(1)} ms`);

  let failed = false;
  if (queryLog.length > QUERY_BOUND) {
    failed = true;
    console.log(`  ✗ N+1 detected: ${queryLog.length} queries > bound ${QUERY_BOUND}`);
  } else {
    console.log(`  ✓ constant query count (${queryLog.length} ≤ ${QUERY_BOUND}) — no per-message queries`);
  }
  if (withReactions < 5 || withReplies < 5) {
    failed = true;
    console.log('  ✗ fixture did not populate reactions/replies');
  } else {
    console.log('  ✓ fixture populated reactions + replies');
  }

  // Cleanup (cascades messages/reactions/memberships).
  await db.conversation.delete({ where: { id: conv.id } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } }).catch(() => {});

  console.log('\n════════════════════════════════════');
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
