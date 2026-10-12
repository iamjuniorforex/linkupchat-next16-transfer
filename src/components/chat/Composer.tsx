'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Smile,
  Paperclip,
  Mic,
  Send,
  Image as ImageIcon,
  FileText,
  Sticker,
  X,
  Reply,
  Play,
  Pause,
  Trash2,
  Film,
  Camera
} from 'lucide-react';
import { cn, EMOJI_SET, STICKERS, formatBytes, formatReplyPreview } from '@/lib/utils';
import { chooseVoiceMime, extensionForMime, normalizeMime } from '@/lib/mime';
import type { MessageDTO } from '@/types';
import { useAuth } from '@/context/AuthProvider';
import { useToast } from '@/components/ui/Toast';

interface ComposerProps {
  conversationId: string;
  onSend: (input: {
    type?: MessageDTO['type'];
    content?: string;
    attachmentIds?: string[];
    replyToId?: string;
  }) => Promise<void> | void;
  onTyping: (isTyping: boolean) => void;
  replyTo: MessageDTO | null;
  onCancelReply: () => void;
  enterToSend: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

/* ── Emoji picker ── */
function EmojiPicker({
  onPick,
  onClose
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<string>('Smileys');
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Emoji picker"
      className="absolute bottom-full left-0 z-30 mb-2 w-[min(92vw,340px)] rounded-2xl border border-border bg-surface p-3 shadow-pop animate-scale-in"
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search emoji…"
        aria-label="Search emoji"
        className="input-base mb-2 !py-2 text-sm"
      />
      <div className="mb-2 flex gap-1 overflow-x-auto no-scrollbar" role="tablist">
        {Object.keys(EMOJI_SET).map((category) => (
          <button
            key={category}
            role="tab"
            aria-selected={tab === category}
            onClick={() => setTab(category)}
            className={cn(
              'whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold transition-colors',
              tab === category ? 'bg-brand-500 text-white' : 'text-muted hover:bg-ink/[0.05]'
            )}
          >
            {category}
          </button>
        ))}
        <button
          role="tab"
          aria-selected={tab === 'Stickers'}
          onClick={() => setTab('Stickers')}
          className={cn(
            'whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold transition-colors',
            tab === 'Stickers' ? 'bg-brand-500 text-white' : 'text-muted hover:bg-ink/[0.05]'
          )}
        >
          Stickers
        </button>
      </div>

      {tab === 'Stickers' ? (
        <div className="grid max-h-52 grid-cols-5 gap-1 overflow-y-auto scroll-thin">
          {STICKERS.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              className="rounded-xl p-2 text-3xl transition-transform hover:scale-110"
              aria-label={`Sticker ${s}`}
            >
              {s}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto scroll-thin">
          {(EMOJI_SET[tab] ?? [])
            .filter(() => true)
            .map((emoji, i) => (
              <button
                key={`${emoji}-${i}`}
                onClick={() => onPick(emoji)}
                className="rounded-lg p-1.5 text-xl transition-transform hover:scale-125"
                aria-label={`Emoji ${emoji}`}
              >
                {emoji}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/* ── Upload helper: real byte-level progress via XHR ── */
class UploadError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

/** The server's exact message, with truthful fallbacks that never confuse a
 *  type rejection with a size problem. */
function uploadErrorDetail(err: unknown): string {
  if (err instanceof UploadError) {
    if (err.message && err.message !== 'Upload failed') return err.message;
    if (err.code === 'FILE_TOO_LARGE') return 'This file exceeds the maximum upload size.';
    if (err.code === 'UNSUPPORTED_TYPE') return 'Unsupported file type.';
    return 'Upload failed. Please try again.';
  }
  return err instanceof Error && err.message ? err.message : 'Upload failed. Please try again.';
}

class UploadAborted extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadAborted';
  }
}

function uploadFileXHR(
  file: File | Blob,
  fileName: string,
  purpose: 'message' | 'voice',
  onProgress: (percent: number) => void,
  onReady?: (abort: () => void) => void
): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onReady?.(() => xhr.abort());
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300 && json.ok) {
          resolve(json.data);
        } else {
          reject(new UploadError(json.error?.message ?? `Upload failed (status ${xhr.status}).`, json.error?.code));
        }
      } catch {
        reject(new UploadError(xhr.status === 413 ? 'This file exceeds the maximum upload size.' : `Upload failed (status ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new UploadError('Network error during upload'));
    xhr.onabort = () => reject(new UploadAborted());
    const fd = new FormData();
    // Preserve the Blob's real MIME type (incl. MediaRecorder codecs params);
    // the server normalizes parameters for classification.
    fd.append('file', file, fileName);
    fd.append('purpose', purpose);
    xhr.send(fd);
  });
}

/* ── Attach menu ── */
function AttachMenu({
  onFiles,
  onClose
}: {
  onFiles: (files: File[], kind: 'image' | 'document' | 'video') => void;
  onClose: () => void;
}) {
  const imageRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  const items = [
    {
      label: 'Photos & Images',
      icon: <ImageIcon className="h-5 w-5" />,
      color: 'text-sky-500 bg-sky-500/10',
      accept: 'image/jpeg,image/png,image/webp,image/gif',
      ref: imageRef,
      kind: 'image' as const
    },
    {
      label: 'Videos',
      icon: <Film className="h-5 w-5" />,
      color: 'text-coral-500 bg-coral-500/10',
      accept: 'video/mp4,video/webm',
      ref: videoRef,
      kind: 'video' as const
    },
    {
      label: 'Documents',
      icon: <FileText className="h-5 w-5" />,
      color: 'text-brand-500 bg-brand-500/10',
      accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip',
      ref: docRef,
      kind: 'document' as const
    }
  ];

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Attach"
      className="absolute bottom-full left-0 z-30 mb-2 w-[min(92vw,280px)] rounded-2xl border border-border bg-surface p-2 shadow-pop animate-scale-in"
    >
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []).slice(0, 1);
          if (selected.length) onFiles(selected, 'image');
          e.target.value = '';
          onClose();
        }}
      />
      <button
        type="button"
        role="menuitem"
        onClick={() => cameraRef.current?.click()}
        className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-ink transition-colors hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-mint-500/10 text-mint-500">
          <Camera className="h-5 w-5" />
        </span>
        Camera
      </button>
      {items.map((item) => (
        <div key={item.label}>
          <input
            ref={item.ref}
            type="file"
            accept={item.accept}
            multiple
            className="hidden"
            onChange={(e) => {
              const selected = Array.from(e.target.files ?? []).slice(0, 10);
              if (selected.length) onFiles(selected, item.kind);
              e.target.value = '';
              onClose();
            }}
          />
          <button
            role="menuitem"
            onClick={() => item.ref.current?.click()}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-ink transition-colors hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]"
          >
            <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', item.color)}>
              {item.icon}
            </span>
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── Voice recorder ── */
function VoiceRecorder({
  onSend,
  onCancel
}: {
  onSend: (blob: Blob) => Promise<void>;
  onCancel: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [playing, setPlaying] = useState(false);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    start();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      mediaRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Produce a browser-compatible audio recording: pick the best voice
      // MIME this browser supports (WebM/Opus, Ogg/Opus, MP4/AAC) instead of
      // assuming a single container everywhere.
      const supportedMime = chooseVoiceMime(
        (t) => typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(t)
      );
      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);
      mediaRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        // Preserve the recorder's ACTUAL output type (e.g. audio/webm;codecs=opus
        // on Chrome, audio/ogg;codecs=opus on Firefox) — never relabel blindly.
        const b = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setBlob(b);
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.start();
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      onCancel();
    }
  }

  function stop() {
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRef.current?.stop();
    setRecording(false);
  }

  function togglePlay() {
    if (!blob) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(URL.createObjectURL(blob));
      audioRef.current.onended = () => setPlaying(false);
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      void audioRef.current.play();
      setPlaying(true);
    }
  }

  return (
    <div className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2.5">
      <button onClick={onCancel} className="icon-btn" aria-label="Cancel recording">
        <Trash2 className="h-4.5 w-4.5 text-coral-500" />
      </button>
      {recording ? (
        <>
          <span className="flex h-2.5 w-2.5 animate-pulse-soft rounded-full bg-coral-500" aria-hidden />
          <span className="text-sm font-medium text-ink">
            Recording… <span className="tabular-nums text-muted">{seconds}s</span>
          </span>
          <span className="flex-1" />
          <button
            onClick={stop}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-coral-500 text-white hover:bg-coral-600"
            aria-label="Stop recording"
          >
            <span className="h-3.5 w-3.5 rounded-sm bg-white" aria-hidden />
          </button>
        </>
      ) : (
        <>
          <button onClick={togglePlay} className="icon-btn" aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause className="h-4.5 w-4.5" /> : <Play className="h-4.5 w-4.5" />}
          </button>
          <span className="text-sm font-medium text-ink">Voice message ready</span>
          <span className="flex-1" />
          <button
            onClick={() => blob && void onSend(blob)}
            disabled={!blob}
            className="btn-primary h-10 px-5"
          >
            <Send className="h-4 w-4" aria-hidden /> Send
          </button>
        </>
      )}
    </div>
  );
}

/* ── Main composer ── */
export function Composer({
  onSend,
  onTyping,
  replyTo,
  onCancelReply,
  enterToSend,
  disabled,
  disabledReason
}: ComposerProps) {
  const { user } = useAuth();
  const toast = useToast();
  const [text, setText] = useState('');
  const [quickReplies, setQuickReplies] = useState<{ id: string; title: string; body: string }[]>([]);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLabel, setUploadLabel] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const abortUploadRef = useRef<(() => void) | null>(null);
  const retryUploadRef = useRef<(() => void) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingRef = useRef(false);
  // Serializes sends: two Enter presses in the same frame must not double-send.
  const sendingRef = useRef(false);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/business/quick-replies', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j.ok && Array.isArray(j.data?.replies) && j.data.replies.length) {
          setQuickReplies(j.data.replies);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const notifyTyping = useCallback(() => {
    if (!typingRef.current) {
      typingRef.current = true;
      onTyping(true);
    }
    // Reset the debounce window; ChatProvider stops typing after 2.5s idle
    onTyping(true);
  }, [onTyping]);

  async function handleSend() {
    if (sendingRef.current) return;
    const content = text.trim();
    if (!content) return;
    sendingRef.current = true;
    setText('');
    if (typingRef.current) {
      typingRef.current = false;
      onTyping(false);
    }
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    try {
      await onSend({
        type: 'TEXT',
        content,
        replyToId: replyTo?.id
      });
      onCancelReply();
    } finally {
      sendingRef.current = false;
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && enterToSend) {
      e.preventDefault();
      void handleSend();
    }
  }

  async function uploadAndSendFiles(files: File[], kind: 'image' | 'document' | 'video') {
    if (!files.length) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    setUploadLabel(files.length === 1 ? files[0]!.name : `${files.length} files`);
    retryUploadRef.current = () => void uploadAndSendFiles(files, kind);
    try {
      const total = files.length;
      const attachmentIds: string[] = [];
      for (let i = 0; i < total; i++) {
        const file = files[i]!;
        const base = (i / total) * 100;
        const data = await uploadFileXHR(
          file,
          file.name,
          'message',
          (pct) => setUploadProgress(Math.round(base + pct / total)),
          (abort) => {
            abortUploadRef.current = abort;
          }
        );
        attachmentIds.push(data.id);
      }
      setUploadProgress(100);
      await onSend({
        type: kind === 'image' ? 'IMAGE' : kind === 'video' ? 'VIDEO' : 'DOCUMENT',
        attachmentIds,
        content: total === 1 ? files[0]!.name : undefined,
        replyToId: replyTo?.id
      });
      onCancelReply();
      setUploadLabel('');
      retryUploadRef.current = null;
    } catch (err) {
      if (err instanceof UploadAborted) {
        setUploadLabel('');
        retryUploadRef.current = null;
        return;
      }
      const detail = uploadErrorDetail(err);
      setUploadError(detail);
      toast.error('Upload failed', detail);
    } finally {
      abortUploadRef.current = null;
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function sendVoice(blob: Blob) {
    setRecording(false);
    setUploading(true);
    setUploadProgress(0);
    try {
      // Filename extension + Content-Type agree with the ACTUAL recorded MIME
      // (e.g. .webm for audio/webm, .ogg for audio/ogg, .m4a for audio/mp4).
      const recordedMime = normalizeMime(blob.type || 'audio/webm');
      const ext = extensionForMime(recordedMime);
      setUploadLabel('Voice message');
      const data = await uploadFileXHR(
        blob,
        `voice-message.${ext === 'bin' ? 'webm' : ext}`,
        'voice',
        setUploadProgress,
        (abort) => {
          abortUploadRef.current = abort;
        }
      );
      await onSend({
        type: 'VOICE',
        attachmentIds: [data.id],
        content: ''
      });
    } catch (err) {
      if (!(err instanceof UploadAborted)) {
        toast.error('Could not send voice message', uploadErrorDetail(err));
      }
      setUploadLabel('');
    } finally {
      abortUploadRef.current = null;
      setUploading(false);
      setUploadProgress(0);
    }
  }

  if (disabled) {
    return (
      <div className="border-t border-border bg-surface px-6 py-4 text-center text-sm text-muted">
        {disabledReason ?? 'You cannot send messages in this conversation.'}
      </div>
    );
  }

  return (
    <div className="composer-dock relative border-t border-border bg-surface px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] pt-2.5 sm:px-4">
      {/* Reply banner */}
      {replyTo && (
        <div className="mb-2 flex items-center gap-3 rounded-xl border-l-4 border-brand-500 bg-brand-500/[0.06] px-3 py-2">
          <Reply className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-brand-600 dark:text-brand-300">
              Replying to {replyTo.sender?.displayName ?? 'message'}
            </p>
            <p className="truncate text-xs text-muted">
              {formatReplyPreview(replyTo)}
            </p>
          </div>
          <button onClick={onCancelReply} className="icon-btn h-11 w-11" aria-label="Cancel reply">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {(uploading || uploadError) && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-ink/[0.04] px-3 py-2 text-xs dark:bg-white/[0.06]" role="status">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink">{uploadError ? 'Upload failed' : `Uploading ${uploadLabel || 'file'}`}</p>
            <p className="truncate text-muted">{uploadError ?? `${uploadProgress}%`}</p>
            {!uploadError && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-brand-500" style={{ width: `${uploadProgress}%` }} />
              </div>
            )}
          </div>
          {uploadError ? (
            <>
              <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => retryUploadRef.current?.()}>
                Retry
              </button>
              <button
                type="button"
                className="icon-btn h-11 w-11"
                aria-label="Dismiss upload error"
                onClick={() => {
                  setUploadError(null);
                  setUploadLabel('');
                  retryUploadRef.current = null;
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => abortUploadRef.current?.()}>
              Cancel
            </button>
          )}
        </div>
      )}

      {quickReplies.length > 0 && (
        <div className="mb-2">
          <button
            type="button"
            className="text-xs font-semibold text-brand-500"
            onClick={() => setRepliesOpen((v) => !v)}
          >
            Quick replies
          </button>
          {repliesOpen && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {quickReplies.map((reply) => (
                <button
                  key={reply.id}
                  type="button"
                  className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-ink"
                  onClick={() => {
                    setText(reply.body);
                    setRepliesOpen(false);
                    textareaRef.current?.focus();
                  }}
                >
                  {reply.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {recording ? (
        <VoiceRecorder onSend={sendVoice} onCancel={() => setRecording(false)} />
      ) : (
        <div className="relative flex items-end gap-1.5">
          {emojiOpen && (
            <EmojiPicker
              onPick={(emoji) => {
                setText((t) => t + emoji);
                textareaRef.current?.focus();
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}
          {attachOpen && (
            <AttachMenu
              onFiles={(files, kind) => void uploadAndSendFiles(files, kind)}
              onClose={() => setAttachOpen(false)}
            />
          )}

          <button
            onClick={() => {
              setEmojiOpen((v) => !v);
              setAttachOpen(false);
            }}
            className="icon-btn h-10 w-10"
            aria-label="Emoji and stickers"
            aria-expanded={emojiOpen}
          >
            <Smile className="h-5 w-5" />
          </button>

          <button
            onClick={() => {
              setAttachOpen((v) => !v);
              setEmojiOpen(false);
            }}
            className="icon-btn h-10 w-10"
            aria-label="Attach file"
            aria-expanded={attachOpen}
          >
            <Paperclip className="h-5 w-5" />
          </button>

          <div className="relative min-w-0 flex-1">
            <textarea
              ref={textareaRef}
              value={text}
              rows={1}
              placeholder="Message…"
              aria-label="Message input"
              enterKeyHint="send"
              autoCapitalize="sentences"
              onChange={(e) => {
                setText(e.target.value);
                notifyTyping();
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
              }}
              onKeyDown={onKeyDown}
              className="scroll-thin max-h-[140px] w-full resize-none rounded-2xl border border-border bg-bg px-4 py-2.5 text-[15px] text-ink placeholder:text-faint focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            {uploading && (
              <div className="absolute inset-x-3 bottom-1.5">
                <div className="h-1 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {text.trim() ? (
            <button
              onClick={() => void handleSend()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white shadow-soft transition-all hover:bg-brand-600 active:scale-95"
              aria-label="Send message"
            >
              <Send className="h-4.5 w-4.5" aria-hidden />
            </button>
          ) : (
            <button
              onClick={() => setRecording(true)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-500 transition-all hover:bg-brand-500/20 active:scale-95"
              aria-label="Record voice message"
            >
              <Mic className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>
      )}

      {enterToSend && (
        <p className="mt-1 hidden text-center text-[10px] text-faint sm:block">
          <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift + Enter</kbd> for a
          new line
        </p>
      )}
    </div>
  );
}

export function formatUploadSize(bytes: number) {
  return formatBytes(bytes);
}

export function useCurrentUser() {
  return useAuth().user;
}
