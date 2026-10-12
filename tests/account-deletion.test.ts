/**
 * Phase 3 — account deletion dependency graph + data-export foundation
 * (Part 6). No destructive endpoint exists yet; this suite pins the tested
 * foundation the future endpoint must build on:
 *
 *  - plan(): deletion steps exist, are ordered, and storage cleanup always
 *    precedes the user-row delete;
 *  - inventory(): counts exactly one user's records, and classifies exclusive
 *    vs shared media correctly (message-attached media is NEVER exclusive);
 *  - collectAccountExport(): a versioned, read-only export containing only
 *    the caller's data (deleted messages carry no content);
 *  - real cascade check: deleting the user row removes their graph and
 *    anonymizes messages (senderId → NULL) while other users stay intact.
 *
 * Run: npm run test:account-deletion   (no app server needed)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReporter } from './helpers';

const report = createReporter();

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
  const { accountDeletionPlan, accountDeletionInventory } = await import('../src/lib/account-deletion');
  const { collectAccountExport, ACCOUNT_EXPORT_VERSION } = await import('../src/lib/account-export');

  await report.check('deletion plan is ordered and storage cleanup precedes the user-row delete', async () => {
    const plan = accountDeletionPlan();
    assert.ok(plan.length >= 5);
    const orders = plan.map((s) => s.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'steps must be sorted by order');
    assert.equal(new Set(orders).size, orders.length, 'orders must be unique');
    for (const step of plan) {
      assert.ok(step.id && step.title && step.detail, 'every step is documented');
      assert.ok(['cascade', 'manual', 'policy'].includes(step.mode));
    }
    const byId = Object.fromEntries(plan.map((s) => [s.id, s]));
    assert.ok(byId['delete-exclusive-storage'], 'storage cleanup step exists');
    assert.ok(byId['delete-user-row'], 'user row delete step exists');
    assert.ok(
      byId['delete-exclusive-storage']!.order < byId['delete-user-row']!.order,
      'storage objects are cleaned before their storageKey reference is lost'
    );
    assert.ok(byId['collect-media']!.order < byId['delete-exclusive-storage']!.order);
    assert.equal(byId['delete-user-row']!.order, Math.max(...orders), 'user row is deleted last');
  });

  // ── Fixture graph ────────────────────────────────────────────────────────
  const stamp = Date.now().toString(36);
  const userA = await db.user.create({
    data: { username: `ada_${stamp}`, displayName: 'Del A', passwordHash: 'x', email: `ada_${stamp}@ex.test` }
  });
  const userB = await db.user.create({
    data: { username: `bob_${stamp}`, displayName: 'Del B', passwordHash: 'x' }
  });

  const conversation = await db.conversation.create({
    data: {
      type: 'DIRECT',
      directKey: `del_${stamp}`,
      members: {
        create: [
          { userId: userA.id, role: 'ADMIN' },
          { userId: userB.id }
        ]
      }
    }
  });

  const sharedAttachment = await db.attachment.create({
    data: {
      uploaderId: userA.id,
      kind: 'IMAGE',
      storageKey: `shared_${stamp}.png`,
      url: `/api/files/shared_${stamp}.png`,
      mimeType: 'image/png',
      sizeBytes: 10
    }
  });
  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      senderId: userA.id,
      type: 'IMAGE',
      content: null,
      attachments: { connect: [{ id: sharedAttachment.id }] }
    }
  });

  const statusAttachment = await db.attachment.create({
    data: {
      uploaderId: userA.id,
      kind: 'STATUS',
      storageKey: `status_${stamp}.jpg`,
      url: `/api/files/status_${stamp}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 20
    }
  });
  const status = await db.status.create({
    data: {
      userId: userA.id,
      type: 'IMAGE',
      attachmentId: statusAttachment.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });

  const orphanAttachment = await db.attachment.create({
    data: {
      uploaderId: userA.id,
      kind: 'VOICE',
      storageKey: `orphan_${stamp}.ogg`,
      url: `/api/files/orphan_${stamp}.ogg`,
      mimeType: 'audio/ogg',
      sizeBytes: 30
    }
  });

  await db.session.create({
    data: { userId: userA.id, tokenHash: `h_${stamp}`, expiresAt: new Date(Date.now() + 86400000) }
  });
  await db.notification.create({
    data: { userId: userA.id, type: 'MESSAGE', title: 'n1' }
  });
  await db.pushSubscription.create({
    data: {
      userId: userA.id,
      endpoint: `https://push.example.test/del_${stamp}`,
      p256dh: 'k',
      auth: 'a'
    }
  });
  await db.contact.create({ data: { ownerId: userA.id, contactId: userB.id } });
  await db.blockedUser.create({ data: { blockerId: userA.id, blockedId: userB.id } });
  await db.messageReaction.create({
    data: { messageId: message.id, userId: userA.id, emoji: '👍' }
  });
  await db.statusView.create({ data: { statusId: status.id, viewerId: userB.id } });
  await db.statusView.create({ data: { statusId: status.id, viewerId: userA.id } });
  await db.call.create({
    data: {
      conversationId: conversation.id,
      callerId: userA.id,
      calleeId: userB.id,
      type: 'VOICE',
      status: 'MISSED'
    }
  });
  const filedReport = await db.report.create({
    data: { reporterId: userA.id, reportedUserId: userB.id, category: 'SPAM' }
  });
  await db.loginEvent.create({ data: { userId: userA.id, success: true } });
  // Noise from user B that must never appear in A's inventory/export.
  await db.notification.create({ data: { userId: userB.id, type: 'MESSAGE', title: 'b-noise' } });
  await db.message.create({
    data: { conversationId: conversation.id, senderId: userB.id, type: 'TEXT', content: 'hi' }
  });

  await report.check('inventory counts exactly one user’s records', async () => {
    const inv = await accountDeletionInventory(userA.id);
    assert.equal(inv.counts.sessions, 1);
    assert.equal(inv.counts.notifications, 1);
    assert.equal(inv.counts.pushSubscriptions, 1);
    assert.equal(inv.counts.contacts, 1);
    assert.equal(inv.counts.blocks, 1);
    assert.equal(inv.counts.conversationMemberships, 1);
    assert.equal(inv.counts.messagesSent, 1);
    assert.equal(inv.counts.reactions, 1);
    assert.equal(inv.counts.statuses, 1);
    assert.equal(inv.counts.statusViews, 1);
    assert.equal(inv.counts.calls, 1);
    assert.equal(inv.counts.reportsFiled, 1);
    assert.equal(inv.counts.loginEvents, 1);
  });

  await report.check('exclusive vs shared media is classified correctly', async () => {
    const inv = await accountDeletionInventory(userA.id);
    const ids = inv.exclusiveMedia.map((m) => m.attachmentId).sort();
    assert.deepEqual(
      ids,
      [statusAttachment.id, orphanAttachment.id].sort(),
      'status + orphan uploads are exclusive; message-attached media is shared'
    );
    assert.equal(inv.sharedMediaCount, 1);
    const keys = inv.exclusiveMedia.map((m) => m.storageKey);
    assert.ok(keys.includes(`status_${stamp}.jpg`));
    assert.ok(keys.includes(`orphan_${stamp}.ogg`));
    assert.equal(keys.includes(`shared_${stamp}.png`), false, 'shared storage is never scheduled');
  });

  await report.check('export is versioned and contains only the caller’s data', async () => {
    const exp = await collectAccountExport(userA.id);
    assert.equal(exp.version, ACCOUNT_EXPORT_VERSION);
    assert.equal(exp.profile.username, `ada_${stamp}`);
    assert.equal(exp.contacts.length, 1);
    assert.equal(exp.contacts[0]!.username, `bob_${stamp}`);
    assert.equal(exp.messages.length, 1);
    assert.equal(exp.messages[0]!.conversationId, conversation.id);
    assert.equal(exp.notifications.length, 1);
    assert.equal(exp.notifications[0]!.title, 'n1');
    assert.equal(exp.reportsFiled.length, 1);
    assert.equal(exp.calls.length, 1);
    assert.equal(exp.statuses.length, 1);
    assert.equal(exp.attachments.length, 3);
    assert.equal(exp.loginEvents.length, 1);
    // No other user's rows leak into the export.
    assert.equal(exp.messages.some((m) => m.content === 'hi'), false);
    assert.equal(exp.notifications.some((n) => n.title === 'b-noise'), false);
  });

  await report.check('export hides content of deleted messages', async () => {
    const exp = await collectAccountExport(userB.id);
    const bMsg = exp.messages.find((m) => m.content === 'hi');
    assert.ok(bMsg);
    await db.message.update({ where: { id: bMsg!.id }, data: { deletedAt: new Date(), content: 'secret' } });
    const exp2 = await collectAccountExport(userB.id);
    const deleted = exp2.messages.find((m) => m.id === bMsg!.id);
    assert.equal(deleted?.content, null);
    assert.ok(deleted?.deletedAt);
  });

  await report.check('deleting the user row cascades their graph and anonymizes messages', async () => {
    const bSessionBefore = await db.session.count({ where: { userId: userB.id } });
    const bNotifBefore = await db.notification.count({ where: { userId: userB.id } });

    await db.user.delete({ where: { id: userA.id } });

    assert.equal(await db.session.count({ where: { userId: userA.id } }), 0);
    assert.equal(await db.notification.count({ where: { userId: userA.id } }), 0);
    assert.equal(await db.pushSubscription.count({ where: { userId: userA.id } }), 0);
    assert.equal(await db.contact.count({ where: { OR: [{ ownerId: userA.id }, { contactId: userA.id }] } }), 0);
    assert.equal(await db.blockedUser.count({ where: { OR: [{ blockerId: userA.id }, { blockedId: userA.id }] } }), 0);
    assert.equal(await db.conversationMember.count({ where: { userId: userA.id } }), 0);
    assert.equal(await db.status.count({ where: { userId: userA.id } }), 0);
    assert.equal(await db.messageReaction.count({ where: { userId: userA.id } }), 0);
    assert.equal(await db.call.count({ where: { OR: [{ callerId: userA.id }, { calleeId: userA.id }] } }), 0);
    assert.equal(await db.report.count({ where: { reporterId: userA.id } }), 0);
    // Retention policy (Task 2): filed reports SURVIVE deletion, anonymized.
    const retained = await db.report.findUnique({ where: { id: filedReport.id } });
    assert.ok(retained, 'filed report must be retained for moderation');
    assert.equal(retained.reporterId, null, 'reporterId must be anonymized to NULL');
    assert.equal(retained.reportedUserId, userB.id, 'report target stays for moderation');
    assert.equal(await db.loginEvent.count({ where: { userId: userA.id } }), 0);

    // Messages are anonymized, not destroyed.
    const anonymized = await db.message.findUnique({ where: { id: message.id } });
    assert.ok(anonymized, 'message survives for the other participant');
    assert.equal(anonymized!.senderId, null);

    // The other user is untouched.
    assert.notEqual(await db.user.findUnique({ where: { id: userB.id } }), null);
    assert.equal(await db.session.count({ where: { userId: userB.id } }), bSessionBefore);
    assert.equal(await db.notification.count({ where: { userId: userB.id } }), bNotifBefore);
    const bMsg = await db.message.findFirst({ where: { conversationId: conversation.id, senderId: userB.id } });
    assert.ok(bMsg, 'B’s message stays');
  });

  // Remaining fixture (B side + conversation + shared attachment rows).
  await db.message.deleteMany({ where: { conversationId: conversation.id } });
  await db.attachment.deleteMany({
    where: { id: { in: [sharedAttachment.id, statusAttachment.id, orphanAttachment.id] } }
  });
  await db.conversation.delete({ where: { id: conversation.id } });
  await db.notification.deleteMany({ where: { userId: userB.id } });
  await db.user.deleteMany({ where: { id: userB.id } });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
