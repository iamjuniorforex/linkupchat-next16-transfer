import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, readJson, ApiError } from '@/lib/api';
import { statusSchema } from '@/lib/validation';
import { statusAudienceFor, visibleStatusWhere } from '@/lib/status-privacy';
import { emitToUsers } from '@/lib/realtime';
import { EVENTS } from '@shared/events';
import { audienceAllows, isStatusTextColor, validateAudienceSelection } from '@/lib/status-stories';
import { notifyStatusUpdates } from '@/lib/status-notify';
import type { StatusDTO } from '@/types';

export const dynamic = 'force-dynamic';

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Status feed — other users' active statuses the viewer is allowed to see
 * (Phase 5B: the viewer's own statuses live at GET /api/status/me).
 * Grouped by author for the story rail.
 */
export const GET = withAuth(async (_req, user) => {
  const { contactIds, blockedIds } = await statusAudienceFor(user.id);

  const statuses = await db.status.findMany({
    where: {
      AND: [visibleStatusWhere(user.id, contactIds, blockedIds), { userId: { not: user.id } }]
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      views: { where: { viewerId: user.id }, select: { id: true } },
      audienceMembers: { select: { userId: true } },
      reactions: { select: { emoji: true, userId: true } }
    }
  });

  const visible = statuses.filter((s) =>
    audienceAllows({
      viewerId: user.id,
      authorId: s.userId,
      audience: s.audience,
      memberIds: s.audienceMembers.map((m) => m.userId)
    })
  );

  // Group by author for the story rail.
  const byUser = new Map<
    string,
    { user: StatusDTO['user']; statuses: StatusDTO[]; isMe: boolean }
  >();

  for (const s of visible) {
    const entry = byUser.get(s.userId) ?? {
      user: s.user,
      statuses: [],
      isMe: false
    };
    entry.statuses.push({
      id: s.id,
      userId: s.userId,
      user: s.user,
      type: s.type as 'TEXT' | 'IMAGE' | 'VIDEO',
      content: s.content,
      background: s.background,
      mediaUrl: s.mediaUrl,
      mediaThumb: s.mediaThumb,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      viewedByMe: s.views.length > 0,
      viewed: s.views.length > 0,
      fontStyle: s.fontStyle,
      textColor: s.textColor,
      audience: s.audience,
      myReaction: s.reactions.find((r) => r.userId === user.id)?.emoji ?? null,
      reactionCount: s.reactions.length
    });
    byUser.set(s.userId, entry);
  }

  const groups = Array.from(byUser.values()).sort((a, b) => {
    const aUnviewed = a.statuses.some((s) => !s.viewedByMe);
    const bUnviewed = b.statuses.some((s) => !s.viewedByMe);
    if (aUnviewed !== bUnviewed) return aUnviewed ? -1 : 1;
    return a.statuses[0]!.createdAt > b.statuses[0]!.createdAt ? -1 : 1;
  });

  return ok({ groups });
});

/**
 * Post a new status (expires after 24 hours).
 *
 * TEXT statuses carry a caption and optional background. IMAGE/VIDEO
 * statuses must reference an uploaded STATUS attachment (Phase 5B) — the
 * server derives all media fields from that attachment and never trusts
 * client-supplied URLs. createdAt/expiresAt are always server-computed.
 */
export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'status:post', 30);
  const body = statusSchema.parse(await readJson(req));

  const content = body.content?.trim() || null;
  const isMedia = body.type === 'IMAGE' || body.type === 'VIDEO';
  const audience = body.audience ?? 'CONTACTS';
  const myContacts = await db.contact.findMany({
    where: { ownerId: user.id },
    select: { contactId: true }
  });
  const audiencePick = validateAudienceSelection({
    audience,
    memberIds: body.audienceUserIds ?? [],
    authorId: user.id,
    contactIds: myContacts.map((c) => c.contactId)
  });
  if (!audiencePick.ok) throw new ApiError('VALIDATION_ERROR', audiencePick.message, 422);
  if (body.textColor && !isStatusTextColor(body.textColor)) {
    throw new ApiError('VALIDATION_ERROR', 'That text color is not available.', 422);
  }

  if (!isMedia && !content) {
    throw new ApiError('VALIDATION_ERROR', 'A text status needs some text.', 422);
  }

  let media: { url: string; thumb: string | null; mimeType: string } | null = null;
  if (isMedia) {
    if (!body.attachmentId) {
      throw new ApiError('VALIDATION_ERROR', 'Media statuses must reference an uploaded file.', 422);
    }
    const attachment = await db.attachment.findUnique({ where: { id: body.attachmentId } });
    if (!attachment) throw new ApiError('VALIDATION_ERROR', 'Uploaded media not found.', 422);
    if (attachment.uploaderId !== user.id) {
      throw new ApiError('VALIDATION_ERROR', 'You can only use your own uploads.', 422);
    }
    if (attachment.kind !== 'STATUS') {
      throw new ApiError('VALIDATION_ERROR', 'Upload the file with the status purpose.', 422);
    }
    if (attachment.messageId) {
      throw new ApiError('VALIDATION_ERROR', 'That file is already attached elsewhere.', 422);
    }
    const okMime = body.type === 'IMAGE'
      ? attachment.mimeType.startsWith('image/')
      : attachment.mimeType.startsWith('video/');
    if (!okMime) {
      throw new ApiError(
        'VALIDATION_ERROR',
        body.type === 'IMAGE' ? 'Image statuses need an image file.' : 'Video statuses need a video file.',
        422
      );
    }
    const inUse = await db.status.findFirst({
      where: { attachmentId: attachment.id, deletedAt: null },
      select: { id: true }
    });
    if (inUse) throw new ApiError('VALIDATION_ERROR', 'That file is already used by a status.', 422);
    media = { url: attachment.url, thumb: attachment.thumbnailUrl, mimeType: attachment.mimeType };
  }

  const createdAt = new Date();
  const status = await db.status.create({
    data: {
      userId: user.id,
      type: body.type,
      content,
      background: isMedia ? null : body.background ?? null,
      attachmentId: isMedia ? body.attachmentId! : null,
      mediaUrl: media?.url ?? null,
      mediaThumb: media?.thumb ?? null,
      mimeType: media?.mimeType ?? null,
      audience,
      fontStyle: isMedia ? null : body.fontStyle ?? 'classic',
      textColor: isMedia ? null : body.textColor ?? '#FFFFFF',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + STATUS_TTL_MS),
      audienceMembers: audiencePick.memberIds.length
        ? { create: audiencePick.memberIds.map((userId) => ({ userId })) }
        : undefined
    }
  });

  const { contactIds, blockedIds } = await statusAudienceFor(user.id);
  const blocked = new Set(blockedIds);
  const listed = new Set(audiencePick.memberIds);
  const notifyIds = contactIds.filter((id) => {
    if (blocked.has(id) || id === user.id) return false;
    if (audience === 'CONTACTS_EXCEPT' && listed.has(id)) return false;
    if (audience === 'ONLY_SHARE' && !listed.has(id)) return false;
    return true;
  });
  emitToUsers(notifyIds, EVENTS.STATUS_NEW, {
    userId: user.id,
    displayName: user.displayName,
    statusId: status.id
  });
  await notifyStatusUpdates(notifyIds, user.id, user.displayName, status.id);

  return ok(
    {
      status: {
        id: status.id,
        type: status.type,
        createdAt: status.createdAt.toISOString(),
        expiresAt: status.expiresAt.toISOString()
      }
    },
    { status: 201 }
  );
});
