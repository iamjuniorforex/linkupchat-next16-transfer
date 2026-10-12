'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { useToast } from '@/components/ui/Toast';
import { cn, formatChatListTime } from '@/lib/utils';
import { STATUS_EMOJIS, statusFontClass, storyDurationMs } from '@/lib/status-stories';
import type { StatusDTO } from '@/types';

export function StatusViewer({
  user,
  statuses,
  index,
  mine,
  onNext,
  onPrev,
  onClose,
  onDelete
}: {
  user: StatusDTO['user'];
  statuses: StatusDTO[];
  index: number;
  mine: boolean;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const toast = useToast();
  const current = statuses[index];
  const [holding, setHolding] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [reaction, setReaction] = useState<string | null>(current?.myReaction ?? null);
  const [viewers, setViewers] = useState<{ displayName: string; viewedAt: string }[] | null>(null);
  const [videoMs, setVideoMs] = useState<number | null>(null);
  const holdStarted = useRef(0);
  const paused = holding || hidden;
  // Text and photo stay at 4s so the existing viewer tests do not race a longer timer.
  const duration = current?.type === 'VIDEO' ? storyDurationMs('VIDEO', videoMs) : 4000;

  useEffect(() => {
    setReaction(current?.myReaction ?? null);
    setViewers(null);
    setVideoMs(null);
    setReply('');
  }, [current?.id, current?.myReaction]);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!current || mine || current.viewedByMe) return;
    void fetch(`/api/status/${current.id}/view`, { method: 'POST', credentials: 'include' }).catch(() => {});
  }, [current?.id, current?.viewedByMe, mine]);

  useEffect(() => {
    if (!current || paused) return;
    const timer = setTimeout(onNext, duration);
    return () => clearTimeout(timer);
  }, [current?.id, duration, onNext, paused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === ' ') {
        e.preventDefault();
        setHolding((h) => !h);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNext, onPrev]);

  if (!current) return null;

  async function react(emoji: string) {
    const res = await fetch(`/api/status/${current!.id}/react`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji })
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      toast.error('Could not react', json.error?.message ?? 'Try again.');
      return;
    }
    setReaction(json.data?.emoji ?? null);
  }

  async function sendReply() {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/status/${current!.id}/reply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, clientNonce: `${Date.now()}-${text.slice(0, 12)}` })
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.error?.message ?? 'Could not send reply');
      setReply('');
      toast.success('Reply sent', 'It was delivered in your chat.');
    } catch (err) {
      toast.error('Could not send reply', err instanceof Error ? err.message : undefined);
    } finally {
      setSending(false);
    }
  }

  async function showViewers() {
    const res = await fetch(`/api/status/${current!.id}`, { credentials: 'include' });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      toast.error('Could not load viewers', json.error?.message);
      return;
    }
    setViewers(json.data?.status?.viewers ?? []);
  }

  return (
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/90 p-3 sm:p-4"
      role="dialog"
      aria-label="Status viewer"
      onClick={onClose}
    >
      <div
        data-testid="status-viewer-card"
        data-paused={paused ? 'true' : 'false'}
        className="relative flex h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-3xl sm:h-[86vh]"
        onClick={(e) => {
          e.stopPropagation();
          if (Date.now() - holdStarted.current > 500) return;
          const rect = e.currentTarget.getBoundingClientRect();
          if (e.clientX - rect.left < rect.width / 2) onPrev();
          else onNext();
        }}
        onPointerDown={() => {
          holdStarted.current = Date.now();
          setHolding(true);
        }}
        onPointerUp={() => setHolding(false)}
        onPointerCancel={() => setHolding(false)}
        style={{
          background: current.background ?? 'linear-gradient(135deg, #6D5EF5 0%, #22B8FF 100%)'
        }}
      >
        <button
          data-testid="status-prev"
          aria-label="Previous status"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          className="absolute left-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white/90 hover:bg-black/55"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </button>
        <button
          data-testid="status-next"
          aria-label="Next status"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="absolute right-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white/90 hover:bg-black/55"
        >
          <ChevronRight className="h-5 w-5" aria-hidden />
        </button>

        <div className="flex gap-1.5 p-3" data-testid="status-progress" aria-hidden>
          {statuses.map((s, i) => (
            <div key={s.id} className="h-1 flex-1 overflow-hidden rounded-full bg-white/30">
              <div
                key={i === index ? `${s.id}-live` : s.id}
                className={cn('h-full bg-white', i === index && 'status-fill')}
                style={{
                  width: i < index ? '100%' : i > index ? '0%' : undefined,
                  animationDuration: i === index ? `${duration}ms` : undefined,
                  animationPlayState: paused ? 'paused' : 'running'
                }}
              />
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 px-4 pb-3">
          <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-white">{user?.displayName ?? 'Status'}</p>
            <p className="text-xs text-white/75">
              {formatChatListTime(current.createdAt)}
              {paused ? ' · Paused' : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-8 text-center">
          {current.type === 'TEXT' ? (
            <p
              className={cn('text-2xl font-bold leading-relaxed', statusFontClass(current.fontStyle))}
              style={{ color: current.textColor ?? '#FFFFFF' }}
            >
              {current.content}
            </p>
          ) : current.type === 'VIDEO' ? (
            <video
              key={current.id}
              src={current.mediaUrl ?? ''}
              className="max-h-full rounded-2xl object-contain"
              autoPlay
              playsInline
              muted={paused}
              onLoadedMetadata={(e) => setVideoMs(Math.round(e.currentTarget.duration * 1000))}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current.mediaUrl ?? ''} alt="Status media" className="max-h-full rounded-2xl object-contain" />
          )}
        </div>

        {current.type !== 'TEXT' && current.content && (
          <p className="px-6 pb-2 text-center text-sm font-medium text-white">{current.content}</p>
        )}

        <div
          className="space-y-2 bg-black/25 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {!mine && (
            <>
              <div className="flex justify-center gap-1.5" role="group" aria-label="React to status">
                {STATUS_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`React ${emoji}`}
                    aria-pressed={reaction === emoji}
                    onClick={() => void react(emoji)}
                    className={cn(
                      'flex h-11 w-11 items-center justify-center rounded-full text-lg',
                      reaction === emoji ? 'bg-white text-ink' : 'bg-white/15'
                    )}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendReply();
                }}
              >
                <input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  aria-label="Reply to status"
                  placeholder={`Reply to ${user?.displayName ?? 'status'}`}
                  maxLength={1000}
                  className="h-10 flex-1 rounded-full bg-white/15 px-4 text-sm text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-white/40"
                />
                <button type="submit" className="rounded-full bg-white px-3 text-sm font-semibold text-ink" disabled={sending || !reply.trim()}>
                  Send
                </button>
              </form>
            </>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <button type="button" onClick={onClose} className="text-sm font-semibold text-white/80">
                Close
              </button>
              {mine && onDelete && (
                <button
                  data-testid="viewer-delete-status"
                  aria-label="Delete status"
                  type="button"
                  onClick={onDelete}
                  className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm font-semibold text-white/90"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                </button>
              )}
            </div>
            {mine && (
              <button type="button" onClick={() => void showViewers()} className="text-sm text-white/80">
                {current.viewerCount ?? 0} viewers
              </button>
            )}
          </div>
          {viewers && (
            <ul className="max-h-28 overflow-y-auto text-left text-sm text-white/90" aria-label="Status viewers">
              {viewers.length === 0 ? (
                <li className="text-white/70">No views yet.</li>
              ) : (
                viewers.map((v) => (
                  <li key={`${v.displayName}-${v.viewedAt}`} className="flex justify-between gap-3 py-0.5">
                    <span>{v.displayName}</span>
                    <span className="text-white/60">{formatChatListTime(v.viewedAt)}</span>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
