/**
 * Media content inspection — no external dependencies.
 *
 * - sniffMime: reads magic bytes so uploads cannot lie about their type.
 * - imageDimensions: parses intrinsic width/height from image headers so the
 *   UI can reserve layout space (no pop-in / layout shift).
 */
import { ALLOWED_MIME } from './storage';

const textDecoder = new TextDecoder('latin1');

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function ascii(buf: Buffer, offset: number, length: number): string {
  return textDecoder.decode(buf.subarray(offset, offset + length));
}

/** Returns the sniffed MIME type, or null when no known signature matches. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;

  // Images
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(buf, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'image/webp';

  // ISO-BMFF (MP4 / QuickTime / AVIF / M4A): [size][ftyp][brand]
  if (ascii(buf, 4, 4) === 'ftyp') {
    const brand = ascii(buf, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    return 'video/mp4'; // isom, mp42, mp41, iso2, avc1…
  }

  // Other video/audio
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'; // Matroska/WebM
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(buf, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(buf, 0, 3) === 'ID3') return 'audio/mpeg';
  if ((buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) && (buf[1] & 0x06) !== 0) return 'audio/mpeg'; // MPEG frame sync
  if (buf[0] === 0xff && (buf[1] === 0xf1 || buf[1] === 0xf9)) return 'audio/aac'; // ADTS

  // Documents
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'application/msword'; // OLE2 container (doc/xls/ppt)
  }
  if (
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buf, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'application/zip'; // also docx/xlsx/pptx
  }

  return null;
}

/**
 * Whether the sniffed content is acceptable for the claimed MIME type.
 * Container formats that share signatures (zip↔docx, ole2↔xls) pass as long
 * as both sides are in the same allowed family.
 */
export function sniffMatchesClaim(claimed: string, sniffed: string | null): boolean {
  // Claims may carry MIME parameters (MediaRecorder: `;codecs=opus`) — only
  // the base type participates in content matching.
  const claim = (claimed ?? '').split(';')[0]!.trim().toLowerCase();
  if (!sniffed) {
    // Signature-less types we explicitly allow (plain text).
    return claim === 'text/plain';
  }
  if (claim === sniffed) return true;

  // Office Open XML (docx/xlsx/pptx) are zip containers.
  const zipFamily = ['application/zip'];
  const ooxml = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ];
  if (sniffed === 'application/zip' && (ooxml.includes(claim) || zipFamily.includes(claim))) {
    return true;
  }
  // Legacy Office (doc/xls/ppt) share the OLE2 signature.
  const ole2 = ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'];
  if (sniffed === 'application/msword' && ole2.includes(claim)) return true;

  // MPEG-4 audio in .m4a containers.
  if (sniffed === 'audio/mp4' && claim === 'audio/x-m4a') return true;

  // video/webm and audio/webm share the Matroska signature.
  if (sniffed === 'video/webm' && claim === 'audio/webm') return true;

  return false;
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Parses intrinsic dimensions from JPEG/PNG/GIF/WebP headers. */
export function imageDimensions(buf: Buffer, mimeType: string): Dimensions | null {
  try {
    switch (mimeType) {
      case 'image/png':
        return pngDimensions(buf);
      case 'image/gif':
        return gifDimensions(buf);
      case 'image/jpeg':
        return jpegDimensions(buf);
      case 'image/webp':
        return webpDimensions(buf);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function pngDimensions(buf: Buffer): Dimensions | null {
  // IHDR is always the first chunk: 8 signature + 4 length + 4 type + width/height
  if (buf.length < 24 || ascii(buf, 12, 4) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifDimensions(buf: Buffer): Dimensions | null {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function jpegDimensions(buf: Buffer): Dimensions | null {
  // Walk JPEG markers to the first Start-Of-Frame.
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1]!;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}

function webpDimensions(buf: Buffer): Dimensions | null {
  const chunk = ascii(buf, 12, 4);
  if (chunk === 'VP8X' && buf.length >= 30) {
    const width = 1 + (buf.readUIntLE(24, 3) & 0xffffff);
    const height = 1 + (buf.readUIntLE(27, 3) & 0xffffff);
    return { width, height };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    // Lossy: 3-byte start code 0x9d 0x01 0x2a, then 14-bit dims
    if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff
      };
    }
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }
  return null;
}

/** Whether an allowlisted type must carry a recognizable file signature. */
export function requiresSignature(mimeType: string): boolean {
  return mimeType !== 'text/plain';
}

/** All MIME types the storage layer accepts (flattened). */
export function isAllowedMime(mimeType: string): boolean {
  return Object.values(ALLOWED_MIME).some((list) =>
    (list as readonly string[]).includes(mimeType)
  );
}
