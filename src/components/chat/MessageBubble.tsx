'use client';

import { memo, useEffect, useRef, useState } from 'react';
import {
  CornerUpLeft,
  Copy,
  Pencil,
  Trash2,
  Forward,
  Pin,
  Flag,
  AlertCircle,
  RotateCw,
  FileText,
  Play,
  Pause,
  SmilePlus,
  Smile
} from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Dropdown, type MenuItem } from '@/components/ui/Dropdown';
import { Modal } from '@/components/ui/Modal';
import {
  cn,
  formatTime,
  linkify,
  EMOJI_REACTIONS,
  formatBytes,
  formatReplyPreview
} from '@/lib/utils';
import type { MessageDTO, AttachmentDTO } from '@/types';

interface MessageBubbleProps {
  message: MessageDTO;
  isGroup: boolean;
  showAvatar: boolean;
  isLastInGroup: boolean;
  onReply: (m: MessageDTO) => void;
  onEdit: (m: MessageDTO) => void;
  onDelete: (m: MessageDTO, forEveryone: boolean) => void;
  onReact: (m: MessageDTO, emoji: string) => void;
  onForward: (m: MessageDTO) => void;
  onReport: (m: MessageDTO) => void;
  onRetry: (m: MessageDTO) => void;
  onOpenMedia: (url: string, type: string) => void;
  /** Scroll to + highlight the original message of a quoted reply. */
  onJumpToReply: (messageId: string) => void;
  /** userId → display info, for "who reacted" labels. */
  members?: Record<string, { displayName: string; username?: string }>;
  searchHighlight?: string;
}

function HighlightedText({ text, highlight }: { text: string; highlight?: string }) {
  if (!highlight) {
    return (
      <>
        {linkify(text).map((part, i) =>
          part.href ? (
            <a
              key={i}
              href={part.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:opacity-80"
            >
              {part.text}
            </a>
          ) : (
            <span key={i}>{part.text}</span>
          )
        )}
      </>
    );
  }
  const idx = text.toLowerCase().indexOf(highlight.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-gold-400/40 px-0.5 text-inherit">{text.slice(idx, idx + highlight.length)}</mark>
      {text.slice(idx + highlight.length)}
    </>
  );
}

function SingleAttachment({ att, onOpenMedia }: { att: AttachmentDTO; onOpenMedia: (url: string, type: string) => void }) {
  if (att.mimeType.startsWith('image/')) {
    return (
      <button
        onClick={() => onOpenMedia(att.url, 'image')}
        className="block overflow-hidden rounded-xl"
        aria-label="Open image"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={att.url}
          alt={att.fileName ?? 'Image'}
          width={att.width ?? undefined}
          height={att.height ?? undefined}
          className="max-h-72 w-auto max-w-full object-cover transition-transform hover:scale-[1.02]"
          loading="lazy"
          draggable={false}
        />
      </button>
    );
  }

  if (att.mimeType.startsWith('video/')) {
    return (
      <video
        src={att.url}
        controls
        className="max-h-72 w-full rounded-xl bg-black"
        preload="metadata"
      />
    );
  }

  if (att.mimeType.startsWith('audio/')) {
    return <audio src={att.url} controls className="w-full max-w-[260px]" preload="metadata" />;
  }

  return (
    <a
      href={att.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-xl border border-white/20 bg-black/[0.06] px-3 py-2.5 dark:bg-white/[0.06]"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-500/20 text-brand-500">
        <FileText className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{att.fileName ?? 'Document'}</span>
        <span className="block text-xs opacity-70">{formatBytes(att.sizeBytes)}</span>
      </span>
    </a>
  );
}

function AttachmentView({ message, onOpenMedia }: { message: MessageDTO; onOpenMedia: (url: string, type: string) => void }) {
  const atts = message.attachments;
  if (!atts.length) return null;

  // A single attachment renders full-size (the common case).
  if (atts.length === 1) {
    return (
      <div className="mt-1">
        <SingleAttachment att={atts[0]!} onOpenMedia={onOpenMedia} />
      </div>
    );
  }

  // Multiple attachments: photos in a compact grid, everything else stacked.
  const images = atts.filter((a) => a.mimeType.startsWith('image/'));
  const others = atts.filter((a) => !a.mimeType.startsWith('image/'));

  return (
    <div className="mt-1 space-y-1">
      {images.length > 0 && (
        <div
          className={cn(
            'grid gap-1 overflow-hidden rounded-xl',
            images.length === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'
          )}
        >
          {images.map((att) => (
            <button
              key={att.id}
              onClick={() => onOpenMedia(att.url, 'image')}
              className="aspect-square overflow-hidden rounded-lg"
              aria-label="Open image"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={att.url}
                alt={att.fileName ?? 'Image'}
                className="h-full w-full object-cover transition-transform hover:scale-[1.05]"
                loading="lazy"
                draggable={false}
              />
            </button>
          ))}
        </div>
      )}
      {others.map((att) => (
        <SingleAttachment key={att.id} att={att} onOpenMedia={onOpenMedia} />
      ))}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isGroup,
  showAvatar,
  isLastInGroup,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onForward,
  onReport,
  onRetry,
  onOpenMedia,
  onJumpToReply,
  members,
  searchHighlight
}: MessageBubbleProps) {
  const [quickReact, setQuickReact] = useState(false);
  const [whoReacted, setWhoReacted] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mine = Boolean(message.isMine);
  const isSystem = message.type === 'SYSTEM';
  const isSticker = message.type === 'STICKER' || message.type === 'GIF';
  // Popover dismissal (UI-only): the picker closes on an outside press or
  // Escape. All state is local to this bubble — no global store.
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pressCountRef = useRef(0);
  /** Set when an outside press dismissed the picker; lets the very next
   *  double-click / long-press of the SAME gesture skip re-opening it. */
  const dismissedByPressRef = useRef<{ at: number; self: boolean; pressCount: number }>({
    at: 0,
    self: false,
    pressCount: 0
  });

  const suppressGestureReopen = (presses: number) => {
    const d = dismissedByPressRef.current;
    return (
      d.self &&
      Date.now() - d.at < 800 &&
      pressCountRef.current - d.pressCount === presses
    );
  };

  const startLongPress = () => {
    cancelLongPress();
    longPressTimer.current = setTimeout(() => {
      // A press that just dismissed the picker must not re-open it on hold.
      if (suppressGestureReopen(1)) return;
      setQuickReact(true);
    }, 450);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => {
    if (!quickReact) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      // Presses inside the picker are left to the emoji buttons so a tap
      // cannot close the popover before React processes the button click.
      if (pickerRef.current?.contains(target)) return;
      dismissedByPressRef.current = {
        at: Date.now(),
        self: wrapperRef.current?.contains(target) ?? false,
        pressCount: pressCountRef.current
      };
      setQuickReact(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQuickReact(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [quickReact]);

  const reactorName = (userId: string) =>
    members?.[userId]?.displayName ?? 'Member';

  if (isSystem) {
    return (
      <div className="my-2 flex justify-center">
        <span className="rounded-full bg-ink/[0.06] px-3.5 py-1.5 text-center text-xs font-medium text-muted dark:bg-white/[0.06]">
          {message.content}
        </span>
      </div>
    );
  }

  const menuItems: MenuItem[] = [
    { label: 'Reply', icon: <CornerUpLeft className="h-4 w-4" />, onClick: () => onReply(message) },
    {
      label: 'React',
      icon: <SmilePlus className="h-4 w-4" />,
      onClick: () => setQuickReact(true)
    },
    {
      label: 'Copy',
      icon: <Copy className="h-4 w-4" />,
      onClick: () => {
        if (message.content) void navigator.clipboard.writeText(message.content);
      },
      disabled: !message.content
    },
    { label: 'Forward', icon: <Forward className="h-4 w-4" />, onClick: () => onForward(message) },
    {
      label: 'Pin',
      icon: <Pin className="h-4 w-4" />,
      onClick: () => onReply(message),
      disabled: true
    }
  ];

  if (message.reactions.length > 0) {
    menuItems.push({
      label: 'See reactions',
      icon: <Smile className="h-4 w-4" />,
      onClick: () => setWhoReacted(true)
    });
  }

  if (mine && !message.deletedAt) {
    menuItems.push(
      {
        label: 'Edit',
        icon: <Pencil className="h-4 w-4" />,
        onClick: () => onEdit(message),
        disabled: message.type !== 'TEXT',
        separatorBefore: true
      },
      {
        label: 'Delete for everyone',
        icon: <Trash2 className="h-4 w-4" />,
        onClick: () => onDelete(message, true),
        danger: true
      }
    );
  } else if (!message.deletedAt) {
    menuItems.push(
      {
        label: 'Delete for me',
        icon: <Trash2 className="h-4 w-4" />,
        onClick: () => onDelete(message, false),
        separatorBefore: true
      },
      {
        label: 'Report',
        icon: <Flag className="h-4 w-4" />,
        onClick: () => onReport(message),
        danger: true
      }
    );
  }

  return (
    <div
      data-message-id={message.id}
      className={cn(
        'group relative flex w-full gap-2 px-3 sm:px-6',
        mine ? 'justify-end' : 'justify-start',
        isLastInGroup ? 'mb-3' : 'mb-0.5'
      )}
    >
      {!mine && isGroup && (
        <div className="w-8 shrink-0 self-end pb-0.5">
          {showAvatar && (
            <Avatar name={message.sender?.displayName ?? '?'} src={message.sender?.avatarUrl} size="xs" />
          )}
        </div>
      )}

      <div
        ref={wrapperRef}
        onPointerDown={() => {
          pressCountRef.current += 1;
        }}
        className={cn('relative max-w-[min(78%,560px)]', mine ? 'items-end' : 'items-start')}
      >
        {/* Quick reactions on hover/long-press.
            Sized by content (w-max), NOT by the bubble width — a one-word
            message must still show all six. Caps at the viewport width and
            scrolls sideways when the viewport is truly narrow; anchored to
            the bubble's outer edge (mine → right, theirs → left) so the row
            extends into free space instead of clipping. */}
        {quickReact && (
          <div
            ref={pickerRef}
            className={cn(
              'absolute -top-11 z-20 w-max max-w-[calc(100vw-1.5rem)] overflow-x-auto overscroll-x-contain rounded-full border border-border bg-surface px-2 py-1.5 shadow-pop animate-scale-in scroll-thin',
              mine ? 'right-0' : 'left-0'
            )}
          >
            <div className="flex w-max items-center gap-0.5">
              {EMOJI_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => {
                    onReact(message, emoji);
                    setQuickReact(false);
                  }}
                  className="shrink-0 rounded-full p-1 text-lg transition-transform hover:scale-125"
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        <div
          onDoubleClick={() => {
            // If this double-click's own press(es) just dismissed the picker,
            // keep it closed (toggle semantics preserved). Real double-clicks
            // report 2 presses; some synthesized ones only 1.
            if (suppressGestureReopen(1) || suppressGestureReopen(2)) return;
            setQuickReact((v) => !v);
          }}
          onTouchStart={startLongPress}
          onTouchEnd={cancelLongPress}
          onTouchMove={cancelLongPress}
          onTouchCancel={cancelLongPress}
          className={cn(
            'relative text-[15px] leading-relaxed',
            isSticker
              ? ''
              : mine
                ? cn(
                    'bg-bubble-out text-white shadow-soft',
                    isLastInGroup
                      ? 'rounded-2xl rounded-tr-md'
                      : 'rounded-2xl'
                  )
                : cn(
                    'border border-border/70 bg-surface text-ink shadow-soft',
                    isLastInGroup ? 'rounded-2xl rounded-tl-md' : 'rounded-2xl'
                  )
          )}
        >
          {/* Reply preview — click to jump to the original message.
              Hidden for deleted replies (a deleted message shows only its
              deleted representation; the quote must not persist). */}
          {message.replyTo && !message.deletedAt && (
            <button
              type="button"
              onClick={() => onJumpToReply(message.replyTo!.id)}
              title="Jump to original message"
              className={cn(
                'mb-1 flex w-full flex-col rounded-xl px-3 py-2 text-left text-[13px] opacity-95 transition-colors hover:brightness-95',
                mine ? 'bg-white/15' : 'bg-brand-500/[0.08]'
              )}
            >
              <span className="text-xs font-semibold">
                {message.replyTo.senderName ?? 'Message'}
              </span>
              <span className="mt-0.5 truncate opacity-80">
                {formatReplyPreview({
                  type: message.replyTo.type,
                  content: message.replyTo.content,
                  deletedAt: message.replyTo.deletedAt
                })}
              </span>
            </button>
          )}

          <div className={cn(isSticker ? '' : 'px-3.5 py-2', message.type === 'TEXT' && !message.content && 'hidden')}>
            {!message.deletedAt && message.content && message.type === 'TEXT' && (
              <p className="whitespace-pre-wrap break-words">
                <HighlightedText text={message.content} highlight={searchHighlight} />
                {message.editedAt && (
                  <span className={cn('ml-1.5 text-[10px]', mine ? 'text-white/70' : 'text-faint')}>
                    (edited)
                  </span>
                )}
              </p>
            )}
            {!message.deletedAt && message.type === 'STICKER' && (
              <span className="block text-6xl leading-none">{message.content}</span>
            )}
            {!message.deletedAt && <AttachmentView message={message} onOpenMedia={onOpenMedia} />}
            {message.deletedAt && (
              <p className={cn('flex items-center gap-1.5 text-[13px] italic', mine ? 'text-white/80' : 'text-faint')}>
                <AlertCircle className="h-3.5 w-3.5" aria-hidden /> This message was deleted
              </p>
            )}
          </div>

          {/* Meta row */}
          <div
            className={cn(
              'flex items-center justify-end gap-1 px-3.5 pb-1.5 pt-0.5',
              isSticker && 'hidden'
            )}
          >
            {message.status === 'SENDING' && (
              <span className={cn('text-[10px]', mine ? 'text-white/70' : 'text-faint')}>Sending…</span>
            )}
            {message.status === 'FAILED' ? (
              <button
                onClick={() => onRetry(message)}
                className="flex items-center gap-1 text-[10px] font-semibold text-coral-500 hover:underline"
                aria-label="Retry sending"
              >
                <RotateCw className="h-3 w-3" aria-hidden /> Retry
              </button>
            ) : (
              <span className={cn('text-[10px]', mine ? 'text-white/75' : 'text-faint')}>
                {formatTime(message.createdAt)}
              </span>
            )}
            {mine && message.status !== 'SENDING' && message.status !== 'FAILED' && (
              <svg width="15" height="11" viewBox="0 0 16 11" fill="none" aria-hidden>
                <path
                  d="M1 5.8 4.2 9 10 2.6"
                  stroke={message.status === 'READ' ? '#7DD3FC' : 'currentColor'}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={mine ? 'text-white/80' : ''}
                />
                {(message.status === 'DELIVERED' || message.status === 'READ') && (
                  <path
                    d="M6 5.8 9.2 9 15 2.6"
                    stroke={message.status === 'READ' ? '#7DD3FC' : 'currentColor'}
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={mine ? 'text-white/80' : ''}
                  />
                )}
              </svg>
            )}
          </div>
        </div>

        {/* Reaction chips */}
        {message.reactions.length > 0 && (
          <div className={cn('-mt-1 flex flex-wrap gap-1', mine ? 'justify-end pr-1' : 'pl-1')}>
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact(message, r.emoji)}
                title={r.userIds.map(reactorName).join(', ')}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow-soft transition-transform hover:scale-105',
                  r.reacted
                    ? 'border-brand-500/50 bg-brand-500/[0.12]'
                    : 'border-border bg-surface'
                )}
                aria-label={`${r.emoji} reaction by ${r.count} ${r.count === 1 ? 'person' : 'people'} — tap to ${r.reacted ? 'remove yours' : 'react'}`}
              >
                <span>{r.emoji}</span>
                {r.count > 1 && <span className="font-semibold text-muted">{r.count}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Action menu */}
        {!message.deletedAt && (
          <div
            className={cn(
              'absolute top-0 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
              mine ? 'right-full mr-1.5' : 'left-full ml-1.5'
            )}
          >
            <Dropdown
              trigger={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="8" cy="3" r="1.6" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.6" fill="currentColor" />
                  <circle cx="8" cy="13" r="1.6" fill="currentColor" />
                </svg>
              }
              items={menuItems}
              align={mine ? 'start' : 'end'}
              triggerClassName="h-7 w-7 bg-surface/90 shadow-soft hover:bg-surface text-muted hover:text-ink"
              triggerProps={{ 'aria-label': 'Message actions' }}
            />
          </div>
        )}
      </div>

      {/* Who reacted */}
      <Modal open={whoReacted} onClose={() => setWhoReacted(false)} title="Reactions" size="sm">
        <div className="space-y-3 py-1">
          {message.reactions.map((r) => (
            <div key={r.emoji} className="flex items-start gap-3">
              <span className="text-xl leading-none">{r.emoji}</span>
              <div className="min-w-0 flex-1">
                {r.userIds.map((uid) => (
                  <p key={uid} className="truncate text-sm text-ink">
                    {reactorName(uid)}
                    {uid === message.senderId && (
                      <span className="ml-1.5 text-xs text-faint">· sender</span>
                    )}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
});
