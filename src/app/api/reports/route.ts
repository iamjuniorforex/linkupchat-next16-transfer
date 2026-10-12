import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, readJson, ApiError } from '@/lib/api';
import { reportSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * File a report against a user or message (Section 24).
 *
 * Phase 3 hardening:
 *  - invalid targets fail safely with 4xx (never a 500);
 *  - message reports require viewability: the reporter must be a member of
 *    the conversation the message lives in (existence is never leaked — an
 *    unviewable message answers the same 404 as a missing one);
 *  - self-reports are rejected;
 *  - duplicate open reports for the same target from the same reporter are
 *    collapsed (the existing report id is returned instead of a new row).
 */
export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'report', 5);
  const body = reportSchema.parse(await readJson(req));

  if (!body.reportedUserId && !body.messageId) {
    throw new ApiError('VALIDATION_ERROR', 'Select a user or message to report.', 422);
  }

  let reportedUserId: string | null = null;
  if (body.reportedUserId) {
    if (body.reportedUserId === user.id) {
      throw new ApiError('VALIDATION_ERROR', 'You cannot report yourself.', 422);
    }
    const target = await db.user.findUnique({
      where: { id: body.reportedUserId },
      select: { id: true }
    });
    if (!target) throw new ApiError('NOT_FOUND', 'The reported user was not found.', 404);
    reportedUserId = target.id;
  }

  let messageId: string | null = null;
  let conversationId: string | null = null;
  if (body.messageId) {
    const msg = await db.message.findUnique({
      where: { id: body.messageId },
      select: { id: true, conversationId: true, senderId: true }
    });
    // Viewability: the reporter must currently be a member of the message's
    // conversation. Missing message and unviewable message are indistinguishable.
    const membership = msg
      ? await db.conversationMember.findFirst({
          where: { conversationId: msg.conversationId, userId: user.id, leftAt: null },
          select: { id: true }
        })
      : null;
    if (!msg || !membership) throw new ApiError('NOT_FOUND', 'Message not found.', 404);
    messageId = msg.id;
    // Server-authoritative — never trust a client-supplied conversation id.
    conversationId = msg.conversationId;
    if (msg.senderId === user.id) {
      throw new ApiError('VALIDATION_ERROR', 'You cannot report your own message.', 422);
    }
  }

  // Duplicate suppression: one open/reviewing report per (reporter, target).
  const duplicate = await db.report.findFirst({
    where: {
      reporterId: user.id,
      status: { in: ['OPEN', 'REVIEWING'] },
      messageId,
      reportedUserId
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdAt: true }
  });
  if (duplicate) {
    return ok(
      {
        reportId: duplicate.id,
        filed: true,
        duplicate: true,
        status: duplicate.status,
        createdAt: duplicate.createdAt.toISOString()
      },
      { status: 200 }
    );
  }

  const report = await db.report.create({
    data: {
      reporterId: user.id,
      reportedUserId,
      messageId,
      conversationId,
      category: body.category,
      reason: body.reason ?? null
    }
  });

  return ok({ reportId: report.id, filed: true, duplicate: false }, { status: 201 });
});

/** My filed reports. */
export const GET = withAuth(async (_req, user) => {
  const reports = await db.report.findMany({
    where: { reporterId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      category: true,
      status: true,
      reason: true,
      createdAt: true,
      resolvedAt: true
    }
  });
  return ok({ reports });
});
