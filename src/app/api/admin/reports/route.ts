import { db } from '@/lib/db';
import { withAuth, requireAdmin, ok, readJson, ApiError } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const reportStatusFilterSchema = z.enum(['OPEN', 'REVIEWING', 'RESOLVED', 'REJECTED']);

/** Moderation queue. */
export const GET = withAuth(async (req, user) => {
  requireAdmin(user);

  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');

  // Invalid status values fail with 400 — never a Prisma 500.
  const status = statusParam ? reportStatusFilterSchema.parse(statusParam) : undefined;

  const reports = await db.report.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      reporter: { select: { id: true, username: true, displayName: true } },
      reportedUser: { select: { id: true, username: true, displayName: true } }
    }
  });

  return ok({
    reports: reports.map((r) => ({
      id: r.id,
      category: r.category,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      reporter: r.reporter,
      reportedUser: r.reportedUser,
      messageId: r.messageId,
      conversationId: r.conversationId
    }))
  });
});

const patchSchema = z.object({
  reportId: z.string(),
  status: z.enum(['REVIEWING', 'RESOLVED', 'REJECTED']),
  note: z.string().max(1000).optional()
});

/** Resolve or reject a report. */
export const PATCH = withAuth(async (req, user) => {
  requireAdmin(user);
  const body = patchSchema.parse(await readJson(req));

  const report = await db.report.findUnique({ where: { id: body.reportId } });
  if (!report) throw new ApiError('NOT_FOUND', 'Report not found.', 404);

  await db.report.update({
    where: { id: body.reportId },
    data: {
      status: body.status,
      resolutionNote: body.note ?? null,
      resolvedAt: body.status === 'REVIEWING' ? null : new Date(),
      resolvedById: body.status === 'REVIEWING' ? null : user.id
    }
  });

  return ok({ reportId: body.reportId, status: body.status });
});
