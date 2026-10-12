/**
 * Unread-count query benchmark — verifies the GET /api/conversations unread
 * computation moved from N per-conversation COUNTs to ONE grouped query with
 * identical semantics.
 *
 * Run: DATABASE_URL=postgresql://… npm run bench:unread
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

type LogEvt = { query: string };
const queryLog: LogEvt[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(db as any).$on('query', (e: LogEvt) => queryLog.push(e));

function baselineOf(lastReadAt: Date | null, joinedAt: Date): Date {
  return lastReadAt && lastReadAt > joinedAt ? lastReadAt : joinedAt;
}

async function main() {
  const userId = process.env.BENCH_USER ?? '';
  if (!userId) {
    // Default: the user with the most memberships (best sample).
    const top = await db.conversationMember.groupBy({
      by: ['userId'],
      where: { leftAt: null },
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 1
    });
    if (!top.length) throw new Error('no memberships in DB — run the e2e suite first');
    return run(top[0]!.userId);
  }
  return run(userId);
}

async function run(userId: string) {
  const memberships = await db.conversationMember.findMany({
    where: { userId, leftAt: null },
    select: { conversationId: true, lastReadAt: true, joinedAt: true }
  });
  console.log(`user ${userId}: ${memberships.length} active conversations`);

  // ── OLD approach: one COUNT per conversation ──
  queryLog.length = 0;
  const tOld = process.hrtime.bigint();
  const oldCounts = new Map<string, number>();
  for (const m of memberships) {
    const c = await db.message.count({
      where: {
        conversationId: m.conversationId,
        senderId: { not: userId },
        deletedAt: null,
        createdAt: { gt: baselineOf(m.lastReadAt, m.joinedAt) }
      }
    });
    oldCounts.set(m.conversationId, c);
  }
  const oldMs = Number(process.hrtime.bigint() - tOld) / 1e6;
  const oldQueries = queryLog.length;

  // ── NEW approach: one grouped query (same semantics) ──
  queryLog.length = 0;
  const tNew = process.hrtime.bigint();
  const rows = memberships.length
    ? await db.$queryRaw<{ conversationId: string; unread: number }[]>`
        SELECT m."conversationId" AS "conversationId", COUNT(*)::int AS unread
        FROM "Message" m
        JOIN "ConversationMember" cm
          ON cm."conversationId" = m."conversationId"
         AND cm."userId" = ${userId}
         AND cm."leftAt" IS NULL
        WHERE m."deletedAt" IS NULL
          AND m."senderId" <> ${userId}
          AND m."conversationId" = ANY(${memberships.map((m) => m.conversationId)}::text[])
          AND m."createdAt" > GREATEST(COALESCE(cm."lastReadAt", TO_TIMESTAMP(0)), cm."joinedAt")
        GROUP BY m."conversationId"
      `
    : [];
  const newMs = Number(process.hrtime.bigint() - tNew) / 1e6;
  const newQueries = queryLog.length;

  // ── Correctness: identical results ──
  const newCounts = new Map(rows.map((r) => [r.conversationId, Number(r.unread) || 0]));
  let mismatches = 0;
  for (const m of memberships) {
    const a = oldCounts.get(m.conversationId) ?? 0;
    const b = newCounts.get(m.conversationId) ?? 0;
    if (a !== b) {
      mismatches += 1;
      console.log(`  MISMATCH ${m.conversationId}: old=${a} new=${b}`);
    }
  }

  console.log('\n── results ──');
  console.log(`old (N COUNTs):  ${memberships.length} queries  ${oldMs.toFixed(1)} ms`);
  console.log(`new (grouped):   ${newQueries} queries  ${newMs.toFixed(1)} ms`);
  console.log(`results identical: ${mismatches === 0 ? 'YES' : `NO (${mismatches} mismatches)`}`);
  console.log(
    `query-count improvement: ${oldQueries} → ${newQueries} (${memberships.length ? (oldQueries / Math.max(1, newQueries)).toFixed(1) : 'n/a'}× fewer)`
  );

  await db.$disconnect();
  process.exit(mismatches === 0 && newQueries < oldQueries ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
