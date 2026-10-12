/**
 * Phase 3 — notification retention (Part 5).
 *
 * Asserts the bounded-cleanup windows on real DB rows:
 *  - READ notifications older than 30 days are pruned;
 *  - UNREAD notifications older than 90 days are pruned;
 *  - unread rows inside the 90-day window are NEVER touched early;
 *  - fresh rows of every user survive;
 *  - cleanup is age-based and identical for all users (it never singles out
 *    one user's data while another's equally-old rows survive).
 *
 * Run: npm run test:notification-retention   (no app server needed)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReporter } from './helpers';

const report = createReporter();
const DAY_MS = 24 * 60 * 60 * 1000;

function loadDbEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  loadDbEnv();
  const { db } = await import('../src/lib/db');
  const { runRetentionSweep, notificationRetentionCutoffs, NOTIFICATION_READ_RETENTION_MS, NOTIFICATION_UNREAD_RETENTION_MS } =
    await import('../src/lib/retention');

  const stamp = Date.now().toString(36);
  const userA = await db.user.create({
    data: { username: `nra_${stamp}`, displayName: 'NR A', passwordHash: 'x' }
  });
  const userB = await db.user.create({
    data: { username: `nrb_${stamp}`, displayName: 'NR B', passwordHash: 'x' }
  });

  const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
  const mk = (userId: string, opts: { createdAt: Date; readAt: Date | null; label: string }) =>
    db.notification.create({
      data: {
        userId,
        type: 'MESSAGE',
        title: opts.label,
        body: 'b',
        createdAt: opts.createdAt,
        readAt: opts.readAt
      }
    });

  const oldRead = await mk(userA.id, { createdAt: ago(40), readAt: ago(35), label: 'old-read' });
  const oldUnread = await mk(userA.id, { createdAt: ago(100), readAt: null, label: 'old-unread' });
  const midUnread = await mk(userA.id, { createdAt: ago(35), readAt: null, label: 'mid-unread' });
  const freshRead = await mk(userA.id, { createdAt: ago(2), readAt: ago(1), label: 'fresh-read' });
  const freshUnread = await mk(userA.id, { createdAt: ago(1), readAt: null, label: 'fresh-unread' });
  const bOldRead = await mk(userB.id, { createdAt: ago(60), readAt: ago(50), label: 'b-old-read' });
  const bFresh = await mk(userB.id, { createdAt: ago(1), readAt: null, label: 'b-fresh' });

  await report.check('cutoffs are 30 days (read) and 90 days (unread)', async () => {
    assert.equal(NOTIFICATION_READ_RETENTION_MS, 30 * DAY_MS);
    assert.equal(NOTIFICATION_UNREAD_RETENTION_MS, 90 * DAY_MS);
    const now = new Date('2026-06-15T12:00:00Z');
    const c = notificationRetentionCutoffs(now);
    assert.equal(c.readBefore.getTime(), now.getTime() - 30 * DAY_MS);
    assert.equal(c.unreadBefore.getTime(), now.getTime() - 90 * DAY_MS);
  });

  await report.check('sweep prunes old read rows and keeps everything younger', async () => {
    await runRetentionSweep();
    assert.equal(await db.notification.findUnique({ where: { id: oldRead.id } }), null);
    assert.notEqual(await db.notification.findUnique({ where: { id: freshRead.id } }), null);
  });

  await report.check('unread rows are never deleted prematurely (35d unread survives)', async () => {
    assert.notEqual(await db.notification.findUnique({ where: { id: midUnread.id } }), null);
    assert.notEqual(await db.notification.findUnique({ where: { id: freshUnread.id } }), null);
  });

  await report.check('unread rows past 90 days ARE pruned (retention stays bounded)', async () => {
    assert.equal(await db.notification.findUnique({ where: { id: oldUnread.id } }), null);
  });

  await report.check('cleanup is age-based across users; fresh rows of others survive', async () => {
    assert.equal(await db.notification.findUnique({ where: { id: bOldRead.id } }), null);
    assert.notEqual(await db.notification.findUnique({ where: { id: bFresh.id } }), null);
  });

  // Cleanup fixture
  await db.notification.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
