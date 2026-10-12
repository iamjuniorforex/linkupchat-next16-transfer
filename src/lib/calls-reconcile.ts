/**
 * Phase 4A — stale call row reconciliation.
 *
 * The authoritative live-call registry is in-memory (see call-state.ts). When
 * the process restarts, any `Call` row still marked RINGING/CONNECTED is
 * orphaned. Run at server startup so persisted history always converges to a
 * final state (missed / ended) consistent with the authoritative state.
 */
import { db } from './db';

export async function reconcileStaleCallRows(now = new Date()): Promise<{ missed: number; ended: number }> {
  const missed = await db.call.updateMany({
    where: { status: 'RINGING', endedAt: null },
    data: { status: 'MISSED', endedAt: now }
  });
  const ended = await db.call.updateMany({
    where: { status: 'CONNECTED', endedAt: null },
    data: { status: 'ENDED', endedAt: now }
  });
  // Group invitees of an orphaned row must not stay INVITED. Failure here
  // (migration not applied yet) must not block 1:1 reconciliation.
  await db.callParticipant
    .updateMany({
      where: { status: 'INVITED', call: { status: { in: ['MISSED', 'CANCELLED', 'DECLINED', 'FAILED'] } } },
      data: { status: 'MISSED', leftAt: now }
    })
    .catch(() => {});
  await db.callParticipant
    .updateMany({
      where: { status: 'JOINED', call: { endedAt: { not: null }, status: { notIn: ['RINGING', 'CONNECTED'] } } },
      data: { status: 'LEFT', leftAt: now }
    })
    .catch(() => {});
  return { missed: missed.count, ended: ended.count };
}
