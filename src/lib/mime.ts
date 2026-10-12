/**
 * Pure MIME helpers shared by the upload pipeline (server) and the composer
 * (browser). No Node-only imports — safe for client bundles.
 *
 * Browser MediaRecorder output carries MIME *parameters* (Chrome:
 * `audio/webm;codecs=opus`, Firefox: `audio/ogg;codecs=opus`). Parameters are
 * irrelevant for type classification — `normalizeMime()` strips them — while
 * content validation (magic bytes) stays exactly as strict as before.
 */

/** Lowercase, trim, and drop MIME parameters (`;codecs=…`). */
export function normalizeMime(mime: string): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  // audio/webm uses the .webm container name browsers save MediaRecorder
  // output under; the registered .weba also maps back to audio/webm when
  // serving stored files.
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip'
};

/** Canonical file extension for a MIME type (parameters accepted and ignored). */
export function extensionForMime(mime: string): string {
  return EXT_BY_MIME[normalizeMime(mime)] ?? 'bin';
}

/**
 * Realistic MediaRecorder voice candidates, most-specific first:
 * WebM/Opus (Chrome/Edge/Opera), Ogg/Opus (Firefox), MP4/AAC (Safari).
 */
export const VOICE_RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'video/mp4' // Safari MediaRecorder (audio-only track in an MP4 container)
] as const;

/**
 * Pick the best voice-recording MIME type this browser supports.
 * Returns null when nothing matches — the caller then lets MediaRecorder
 * choose its own default (still preserved verbatim on the resulting Blob).
 */
export function chooseVoiceMime(isTypeSupported: (type: string) => boolean): string | null {
  for (const candidate of VOICE_RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // some browsers throw on unknown types — keep trying
    }
  }
  return null;
}
