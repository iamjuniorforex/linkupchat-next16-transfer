import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, ApiError } from '@/lib/api';
import { storeUpload, classifyMime, MAX_AVATAR_BYTES, MAX_AVATAR_MB } from '@/lib/storage';
import { normalizeMime } from '@/lib/mime';
import { accessFor } from '@/lib/billing';
import { uploadLimitBytes } from '@/lib/entitlements';

export const dynamic = 'force-dynamic';

/**
 * Multipart upload endpoint (Section 20).
 * Validates file type + size (including magic-byte content sniffing),
 * stores in object storage and returns an Attachment record the client can
 * attach to messages/statuses.
 */
export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'upload', 30);
  const form = await req.formData().catch(() => {
    throw new ApiError('BAD_REQUEST', 'Invalid upload payload.');
  });

  const file = form.get('file');
  const purpose = String(form.get('purpose') ?? 'message');

  if (!(file instanceof File)) {
    throw new ApiError('BAD_REQUEST', 'No file provided.');
  }
  const access = await accessFor(user.id);
  const limit = uploadLimitBytes(access.plan, purpose);
  const limitMb = Math.max(1, Math.round(limit / (1024 * 1024)));
  if (file.size > limit) {
    throw new ApiError('FILE_TOO_LARGE', `File is too large (max ${limitMb}MB).`);
  }
  // Profile photos (Phase 5A): tighter size cap — nothing else changes.
  if ((purpose === 'avatar' || purpose === 'cover' || purpose === 'group') && file.size > MAX_AVATAR_BYTES) {
    throw new ApiError('FILE_TOO_LARGE', `Profile photos must be ${MAX_AVATAR_MB}MB or smaller.`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // MediaRecorder output carries MIME parameters (`audio/webm;codecs=opus`) —
  // classify/store on the normalized base type; magic bytes still verify it.
  const mimeType = normalizeMime(file.type) || 'application/octet-stream';

  if (!classifyMime(mimeType)) {
    throw new ApiError('UNSUPPORTED_TYPE', 'Unsupported file type.');
  }

  let stored;
  try {
    stored = await storeUpload({
      file: buffer,
      mimeType,
      fileName: file.name || 'upload',
      maxBytes: limit
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed.';
    if (message.includes('too large')) throw new ApiError('FILE_TOO_LARGE', message);
    if (message.includes('Unsupported')) throw new ApiError('UNSUPPORTED_TYPE', message);
    if (message.includes('does not match')) throw new ApiError('UNSUPPORTED_TYPE', message);
    if (message.includes('not configured')) throw new ApiError('STORAGE_UNAVAILABLE', message, 503);
    throw new ApiError('UPLOAD_FAILED', message, 500);
  }

  const family = classifyMime(stored.mimeType)!;
  const isImage = family === 'image' || family === 'gif' || family === 'sticker';

  // Group photos (D3): upload with purpose=group → GROUP_AVATAR attachment,
  // whose URL the client PATCHes onto the conversation avatar.
  if (purpose === 'group' && !isImage) {
    throw new ApiError('UNSUPPORTED_TYPE', 'Group photos must be images.', 400);
  }
  // Profile photos (Phase 5A): images only — reject before anything is stored
  // so non-image "avatar" uploads never create orphaned objects.
  if ((purpose === 'avatar' || purpose === 'cover') && !isImage) {
    throw new ApiError('UNSUPPORTED_TYPE', 'Profile photos must be images.', 400);
  }
  // Status media (Phase 5B): images and videos only — documents/audio are not
  // valid status types, rejected before anything is stored.
  if (purpose === 'status' && !(isImage || family === 'video')) {
    throw new ApiError('UNSUPPORTED_TYPE', 'Status updates support images and videos only.', 400);
  }

  const kind =
    purpose === 'avatar' && isImage
      ? 'AVATAR'
      : purpose === 'cover' && isImage
        ? 'COVER'
      : purpose === 'group'
        ? 'GROUP_AVATAR'
        : purpose === 'status'
          ? 'STATUS'
          : purpose === 'voice'
            ? 'VOICE'
            : family === 'gif'
              ? 'GIF'
              : family === 'sticker'
                ? 'STICKER'
                : (family.toUpperCase() as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT');

  const attachment = await db.attachment.create({
    data: {
      uploaderId: user.id,
      kind,
      storageKey: stored.storageKey,
      url: stored.url,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      width: stored.width,
      height: stored.height,
      fileName: stored.fileName
    }
  });

  return ok({
    id: attachment.id,
    url: attachment.url,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
    fileName: attachment.fileName
  });
});
