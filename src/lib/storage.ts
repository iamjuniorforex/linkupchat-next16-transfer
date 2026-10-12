import { mkdir, writeFile, unlink, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import type { Readable } from 'stream';
import { randomBytes } from 'crypto';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import { imageDimensions, requiresSignature, sniffMatchesClaim, sniffMime } from './media';
import { normalizeMime } from './mime';

/**
 * Object storage abstraction (Section 20).
 *
 * Development driver: local disk (UPLOAD_DIR).
 * Production driver: S3-compatible object storage — set STORAGE_DRIVER="s3"
 * and the S3_* environment variables. Large media is never stored in the
 * database; only storage keys and metadata are.
 */

const DRIVER = process.env.STORAGE_DRIVER ?? 'local';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? './uploads');
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 25);

export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** Profile photos get a tighter cap than general uploads (Phase 5A). */
export const MAX_AVATAR_MB = 5;
export const MAX_AVATAR_BYTES = MAX_AVATAR_MB * 1024 * 1024;

// Allowed MIME types by family — uploads are validated before anything is written.
export const ALLOWED_MIME = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/wav', 'audio/x-m4a', 'audio/aac'],
  document: [
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip'
  ]
} as const;

export type UploadFamily = keyof typeof ALLOWED_MIME;

export function classifyMime(mime: string): UploadFamily | 'gif' | 'sticker' | null {
  // MIME *parameters* (e.g. `audio/webm;codecs=opus` from MediaRecorder) are
  // irrelevant for classification — only the base type is matched against the
  // allowlist. Content validation (magic bytes) remains unchanged.
  const m = normalizeMime(mime);
  if (m === 'image/gif') return 'gif';
  if (m === 'image/webp') return 'sticker';
  for (const [family, list] of Object.entries(ALLOWED_MIME)) {
    if ((list as readonly string[]).includes(m)) return family as UploadFamily;
  }
  return null;
}

export interface StoredObject {
  storageKey: string;
  url: string;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
  width: number | null;
  height: number | null;
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/webm': 'weba',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/zip': 'zip'
  };
  return map[mime] ?? 'bin';
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}

/**
 * Validates and stores a single upload. Throws friendly errors suitable
 * for direct display to end users.
 *
 * The claimed MIME type is verified against the file's actual content
 * (magic bytes), so renamed files cannot smuggle a different type through.
 */
export async function storeUpload(opts: {
  file: Buffer;
  mimeType: string;
  fileName: string;
  family?: UploadFamily | 'gif' | 'sticker';
  /** Caller-supplied cap. Never above the absolute premium ceiling. */
  maxBytes?: number;
}): Promise<StoredObject> {
  // The browser-declared type may carry parameters (`;codecs=opus`) — the
  // claim is normalized for classification/validation; bytes still decide.
  const claimed = normalizeMime(opts.mimeType);
  if (!classifyMime(claimed)) {
    throw new Error('Unsupported file type');
  }
  const absoluteCap = Math.max(MAX_UPLOAD_BYTES, 100 * 1024 * 1024);
  const cap = Math.min(opts.maxBytes ?? MAX_UPLOAD_BYTES, absoluteCap);
  if (opts.file.byteLength > cap) {
    const mb = Math.max(1, Math.round(cap / (1024 * 1024)));
    throw new Error(`File is too large (max ${mb}MB)`);
  }

  // Content sniffing — the browser-declared type must match the real bytes.
  const sniffed = sniffMime(opts.file);
  if (!sniffMatchesClaim(claimed, sniffed)) {
    throw new Error('File content does not match its type');
  }
  if (!sniffed && requiresSignature(claimed)) {
    throw new Error('File content does not match its type');
  }
  // Trust the sniffed type when available — except when the sniff only
  // identifies a generic container alias for a more specific claimed type
  // (Matroska audio/webm files sniff as video/webm). In that case the
  // verified claim is the accurate label (preserves MediaRecorder output).
  const mimeType =
    sniffed && !(sniffed === 'video/webm' && claimed === 'audio/webm') ? sniffed : claimed;

  const dims = imageDimensions(opts.file, mimeType);

  const ext = extFromMime(mimeType);
  const day = new Date().toISOString().slice(0, 10);
  const storageKey = `${day}/${randomBytes(12).toString('hex')}.${ext}`;
  const fileName = sanitizeFileName(opts.fileName);

  if (DRIVER === 's3') {
    return storeS3({
      file: opts.file,
      mimeType,
      fileName,
      storageKey,
      size: opts.file.byteLength,
      width: dims?.width ?? null,
      height: dims?.height ?? null
    });
  }

  const fullDir = path.join(UPLOAD_DIR, day);
  await mkdir(fullDir, { recursive: true });
  const fullPath = path.join(UPLOAD_DIR, storageKey);
  await writeFile(fullPath, opts.file);

  return {
    storageKey,
    url: `/api/files/${storageKey}`,
    sizeBytes: opts.file.byteLength,
    mimeType,
    fileName,
    width: dims?.width ?? null,
    height: dims?.height ?? null
  };
}

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, DO Spaces...).
 * Credentials come exclusively from the S3_* environment variables --
 * nothing secret is ever hard-coded.
 */
function s3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    // Path-style works with every S3-compatible provider and is required
    // by MinIO-style endpoints.
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!
    }
  });
}

/**
 * Canonical media href for clients. Media is served through the authenticated
 * `/api/files` proxy — never a public bucket URL — so access stays scoped to
 * logged-in users. Legacy rows written before this change still hold public
 * S3 URLs; `mediaHref` rewrites them at the ORM layer (see lib/db.ts).
 */
export function mediaHref(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/api/files/')) return url;
  for (const base of [process.env.S3_PUBLIC_URL ?? '', process.env.S3_ENDPOINT ?? '']) {
    const b = base.replace(/\/$/, '');
    if (b && url.startsWith(`${b}/`)) return `/api/files/${url.slice(b.length + 1)}`;
  }
  return url;
}

async function storeS3(opts: {
  file: Buffer;
  mimeType: string;
  fileName: string;
  storageKey: string;
  size: number;
  width: number | null;
  height: number | null;
}): Promise<StoredObject> {
  const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Object storage is not configured (${key} missing)`);
    }
  }

  await s3Client().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: opts.storageKey,
      Body: opts.file,
      ContentType: opts.mimeType,
      ContentDisposition: `inline; filename="${opts.fileName}"`
    })
  );

  return {
    storageKey: opts.storageKey,
    // Authenticated proxy URL (audit H-1): objects are private; clients fetch
    // them through /api/files which checks who may read the attachment.
    url: `/api/files/${opts.storageKey}`,
    sizeBytes: opts.size,
    mimeType: opts.mimeType,
    fileName: opts.fileName,
    width: opts.width,
    height: opts.height
  };
}

export function resolveLocalPath(storageKey: string): string {
  const full = path.resolve(UPLOAD_DIR, storageKey);
  // Path-traversal protection: the resolved path must stay inside UPLOAD_DIR.
  if (!full.startsWith(UPLOAD_DIR + path.sep)) {
    throw new Error('Invalid file path');
  }
  return full;
}

export async function deleteStoredObject(storageKey: string) {
  if (DRIVER === 's3') {
    const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
    if (required.some((key) => !process.env[key])) return;
    await s3Client()
      .send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageKey }))
      .catch(() => {});
    return;
  }
  try {
    const full = resolveLocalPath(storageKey);
    await stat(full);
    await unlink(full);
  } catch {
    // already gone
  }
}

/**
 * Size of a stored object, or null when it does not exist. Driver-agnostic
 * (audit H-1): the files route serves local disk and S3/R2 the same way.
 */
export async function statStoredObject(storageKey: string): Promise<{ size: number } | null> {
  if (DRIVER === 's3') {
    const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
    if (required.some((key) => !process.env[key])) return null;
    try {
      const res = await s3Client().send(
        new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageKey })
      );
      return { size: res.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }
  try {
    const st = await stat(resolveLocalPath(storageKey));
    return st.isFile() ? { size: st.size } : null;
  } catch {
    return null;
  }
}

/**
 * Open a read stream for a stored object (optionally one HTTP range) — used
 * by the authenticated /api/files proxy. Returns null when unreadable.
 */
export async function readStoredObject(
  storageKey: string,
  range?: { start: number; end: number }
): Promise<Readable | null> {
  try {
    if (DRIVER === 's3') {
      const res = await s3Client().send(
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: storageKey,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined
        })
      );
      return (res.Body as Readable | undefined) ?? null;
    }
    return createReadStream(
      resolveLocalPath(storageKey),
      range ? { start: range.start, end: range.end } : undefined
    );
  } catch {
    return null;
  }
}
