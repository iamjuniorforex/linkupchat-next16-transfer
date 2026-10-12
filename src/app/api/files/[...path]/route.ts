import { Readable } from 'stream';
import { getSessionUser } from '@/lib/auth';
import { fail } from '@/lib/api';
import { db } from '@/lib/db';
import { statStoredObject, readStoredObject } from '@/lib/storage';
import { loadStatusForViewer } from '@/lib/status-privacy';
import { canSeePrivacy } from '@/lib/serialize';
import type { AttachmentKind } from '@prisma/client';

export const dynamic = 'force-dynamic';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  weba: 'audio/webm',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  zip: 'application/zip',
  bin: 'application/octet-stream'
};

interface AttachmentRow {
  id: string;
  kind: AttachmentKind;
  messageId: string | null;
  uploaderId: string | null;
  url: string;
}

/**
 * May this user read this stored object? (audit H-1 — media is served only to
 * users related to the attachment, never to any random session.)
 *
 * - the uploader always sees their own upload;
 * - avatars/group avatars render app-wide → any authenticated user;
 * - message/voice attachments → sender or current conversation members;
 * - status attachments → owner, or while an active status is visible to the
 *   viewer under the status-privacy rules.
 */
async function attachmentReadableBy(userId: string, a: AttachmentRow): Promise<boolean> {
  if (a.uploaderId === userId) return true;
  if (a.kind === 'GROUP_AVATAR') return true;
  if (a.kind === 'AVATAR' || a.kind === 'COVER') {
    if (!a.uploaderId) return false;
    const owner = await db.user.findUnique({
      where: { id: a.uploaderId },
      select: {
        avatarUrl: true,
        coverUrl: true,
        settings: { select: { privacyProfilePhoto: true } }
      }
    });
    const isCurrent =
      a.kind === 'AVATAR' ? owner?.avatarUrl === a.url : owner?.coverUrl === a.url;
    // Unused uploads stay readable by any signed-in user, matching the
    // existing avatar media rule. A photo actually on the profile follows
    // privacyProfilePhoto.
    if (!isCurrent) return a.kind === 'AVATAR';
    const isContact = Boolean(
      await db.contact.findFirst({
        where: { ownerId: userId, contactId: a.uploaderId },
        select: { id: true }
      })
    );
    return canSeePrivacy(owner?.settings?.privacyProfilePhoto, isContact);
  }

  if (a.messageId) {
    const message = await db.message.findUnique({
      where: { id: a.messageId },
      select: { senderId: true, conversationId: true }
    });
    if (!message) return false;
    if (message.senderId === userId) return true;
    const member = await db.conversationMember.findFirst({
      where: { conversationId: message.conversationId, userId, leftAt: null }
    });
    return Boolean(member);
  }

  const status = await db.status.findFirst({
    where: { attachmentId: a.id, deletedAt: null },
    select: { id: true, userId: true }
  });
  if (!status) return false;
  if (status.userId === userId) return true;
  const visible = await loadStatusForViewer(userId, status.id);
  return Boolean(visible?.active);
}

/**
 * Serves stored media through an authenticated, authorization-scoped proxy
 * (audit H-1). Private media can be hot-linked by nobody without a session,
 * and a session only reaches objects it is related to.
 *
 * Supports HTTP Range requests (206 partial content) so video/audio seeking
 * works in every browser player -- Safari requires real range support.
 */
export async function GET(req: Request, ctx: { params: { path: string[] } }) {
  const user = await getSessionUser();
  if (!user) return fail('UNAUTHORIZED', 'Please log in to access media.', 401);

  const key = ctx.params.path.join('/');

  // Only objects that exist as stored attachments are servable at all.
  const attachments = await db.attachment.findMany({
    where: { storageKey: key },
    select: { id: true, kind: true, messageId: true, uploaderId: true, url: true }
  });
  const allowed = await Promise.all(attachments.map((a) => attachmentReadableBy(user.id, a)));
  // 404 (not 403) so probing cannot confirm which keys exist.
  if (!allowed.some(Boolean)) return fail('NOT_FOUND', 'File not found.', 404);

  const info = await statStoredObject(key);
  if (!info) return fail('NOT_FOUND', 'File not found.', 404);

  const ext = key.split('.').pop()?.toLowerCase() ?? 'bin';
  const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const fileName = key.split('/').pop() ?? 'file';

  const baseHeaders: Record<string, string> = {
    'Content-Type': mimeType,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${fileName}"`,
    'Accept-Ranges': 'bytes'
  };

  // Parse a single-range request: bytes=start-end (and bytes=-N suffix form)
  const rangeHeader = req.headers.get('range');
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const rawStart = match[1] ?? '';
      const rawEnd = match[2] ?? '';
      let start: number;
      let end: number;
      if (rawStart === '' && rawEnd !== '') {
        const suffix = Number(rawEnd);
        start = Math.max(0, info.size - suffix);
        end = info.size - 1;
      } else {
        start = Number(rawStart || 0);
        end = rawEnd !== '' ? Math.min(Number(rawEnd), info.size - 1) : info.size - 1;
      }

      if (start > end || start >= info.size) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${info.size}` }
        });
      }

      const stream = await readStoredObject(key, { start, end });
      if (!stream) return fail('NOT_FOUND', 'File not found.', 404);
      const webStream = Readable.toWeb(stream) as ReadableStream;
      return new Response(webStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${info.size}`
        }
      });
    }
  }

  const stream = await readStoredObject(key);
  if (!stream) return fail('NOT_FOUND', 'File not found.', 404);
  const webStream = Readable.toWeb(stream) as ReadableStream;

  return new Response(webStream, {
    headers: {
      ...baseHeaders,
      'Content-Length': String(info.size)
    }
  });
}
