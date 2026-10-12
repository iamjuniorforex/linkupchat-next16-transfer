import { db } from '@/lib/db';
import { withAuth, requireAdmin, ok, ApiError } from '@/lib/api';
import { reviewVerification } from '@/lib/business-rules';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  requireAdmin(user);
  const rows = await db.businessProfile.findMany({
    where: { verificationStatus: 'PENDING' },
    include: { user: { select: { id: true, username: true, displayName: true } } },
    orderBy: { updatedAt: 'asc' },
    take: 50
  });
  return ok({
    requests: rows.map((row) => ({
      userId: row.userId,
      username: row.user.username,
      displayName: row.user.displayName,
      name: row.name,
      category: row.category,
      website: row.website,
      verificationStatus: row.verificationStatus
    }))
  });
});

export const POST = withAuth(async (req, user) => {
  requireAdmin(user);
  const body = await req.json().catch(() => ({}));
  const userId = String(body.userId || '');
  const decision = body.decision === 'APPROVED' || body.decision === 'REJECTED' ? body.decision : null;
  if (!userId || !decision) throw new ApiError('VALIDATION_ERROR', 'A user and decision are required.', 400);
  const gate = reviewVerification({
    actorId: user.id,
    actorRole: user.role,
    targetUserId: userId,
    decision
  });
  if (!gate.ok) throw new ApiError('FORBIDDEN', gate.reason, 403);
  const profile = await db.businessProfile.findUnique({ where: { userId } });
  if (!profile || profile.verificationStatus !== 'PENDING') {
    throw new ApiError('NOT_FOUND', 'No pending verification request.', 404);
  }
  await db.businessProfile.update({
    where: { userId },
    data: {
      verificationStatus: decision,
      verificationNote: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
      reviewedAt: new Date(),
      reviewedById: user.id
    }
  });
  return ok({ verificationStatus: decision });
});
