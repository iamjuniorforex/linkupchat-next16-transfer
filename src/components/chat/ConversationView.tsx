'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Phone,
  Video,
  Search,
  MoreVertical,
  ChevronDown,
  Users,
  BellOff,
  Bell,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  UserX,
  Flag,
  Trash2,
  Info,
  X,
  AlertCircle,
  Palette
} from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Dropdown, type MenuItem } from '@/components/ui/Dropdown';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { MessageListSkeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useNotifications } from '@/context/NotificationProvider';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import { cn, formatDateSeparator, formatRelativeLastSeen, isToday } from '@/lib/utils';
import { wallpaperStyle } from '@/lib/wallpapers';
import { chatThemeStyle } from '@/lib/chat-themes';
import { CHAT_THEMES } from '@/lib/plans';
import { useChat } from '@/context/ChatProvider';
import { useSocket } from '@/context/SocketProvider';
import { useAuth } from '@/context/AuthProvider';
import { isSafeSegment } from '@/lib/notifications';
import { firstUnreadMessageId } from '@/lib/unread';
import { EVENTS } from '@shared/events';
import type { ConversationDTO, MessageDTO } from '@/types';

function TypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const label =
    names.length === 1
      ? `${names[0]} is typing…`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing…`
        : `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'} are typing…`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 px-6 pb-1.5 text-xs text-muted"
    >
      <span className="flex items-center gap-1 rounded-full bg-brand-500/[0.1] px-2.5 py-1.5">
        <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-500" />
        <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-500 [animation-delay:0.15s]" />
        <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-500 [animation-delay:0.3s]" />
      </span>
      {label}
    </div>
  );
}

function DateSeparator({ date }: { date: string }) {
  return (
    <div className="my-4 flex items-center justify-center" role="separator">
      <span className="rounded-full bg-ink/[0.06] px-3.5 py-1 text-xs font-semibold text-muted dark:bg-white/[0.07]">
        {formatDateSeparator(date)}
      </span>
    </div>
  );
}

/** Marks the boundary of the messages that were unread when the chat opened. */
function UnreadSeparator() {
  return (
    <div className="my-3 flex items-center gap-3 px-2" role="separator" aria-label="Unread messages">
      <span aria-hidden className="h-px flex-1 bg-coral-500/35" />
      <span className="rounded-full border border-coral-500/30 bg-coral-500/[0.12] px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-coral-600 dark:text-coral-400">
        Unread messages
      </span>
      <span aria-hidden className="h-px flex-1 bg-coral-500/35" />
    </div>
  );
}

function MediaViewer({
  url,
  type,
  onClose
}: {
  url: string | null;
  type: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!url) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 p-4 animate-fade-in"
      role="dialog"
      aria-label="Media viewer"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute right-5 top-5 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        aria-label="Close media viewer"
      >
        <X className="h-6 w-6" />
      </button>
      <div className="max-h-[90vh] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        {type === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="Media preview" className="max-h-[88vh] rounded-2xl object-contain" />
        ) : (
          <video src={url} controls autoPlay className="max-h-[88vh] rounded-2xl" />
        )}
      </div>
    </div>
  );
}

interface ConversationViewProps {
  conversation: ConversationDTO;
  onBack: () => void;
  onOpenInfo: () => void;
  onStartCall?: (type: 'VOICE' | 'VIDEO') => void;
}

export function ConversationView({ conversation, onBack, onOpenInfo, onStartCall }: ConversationViewProps) {
  const { user } = useAuth();
  const { socket, presence } = useSocket();
  const toast = useToast();
  const {
    messages,
    messagesLoaded,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    sendMessage,
    retryMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    forwardMessage,
    markRead,
    typing,
    setTyping,
    patchConversation,
    conversations,
    messagesError,
    retryMessages
  } = useChat();

  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [editing, setEditing] = useState<MessageDTO | null>(null);
  const [editText, setEditText] = useState('');
  const [forwardMsg, setForwardMsg] = useState<MessageDTO | null>(null);
  const [reportMsg, setReportMsg] = useState<MessageDTO | null>(null);
  const [reportCategory, setReportCategory] = useState('SPAM');
  const [deleteMsg, setDeleteMsg] = useState<MessageDTO | null>(null);
  const [media, setMedia] = useState<{ url: string; type: string } | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [chatTheme, setChatTheme] = useState('default');
  const [themeOpen, setThemeOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const list = messages[conversation.id] ?? [];
  const loaded = messagesLoaded[conversation.id];
  const typingNames = typing[conversation.id] ?? [];

  // ── Unread-message separator anchor ──
  // Captured ONCE per conversation session, at open time, before the
  // visibility-driven read-sync below can zero the live unread count. The
  // divider then stays pinned at the boundary of what was unread when the
  // thread was opened (and is not resurrected on a later re-open).
  const [unreadAnchor, setUnreadAnchor] = useState<{ convId: string; beforeId: string | null } | null>(
    null
  );
  const unreadAtOpenRef = useRef<Record<string, number>>({});
  const prevConvIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevConvIdRef.current !== conversation.id) {
      prevConvIdRef.current = conversation.id;
      // New open session: forget any stale capture for this conversation.
      delete unreadAtOpenRef.current[conversation.id];
      setUnreadAnchor(null);
    }
    if (unreadAtOpenRef.current[conversation.id] === undefined) {
      unreadAtOpenRef.current[conversation.id] = conversation.unreadCount;
    }
    const count = unreadAtOpenRef.current[conversation.id] ?? 0;
    if (count <= 0 || list.length === 0) return;
    setUnreadAnchor((prev) =>
      prev && prev.convId === conversation.id
        ? prev
        : { convId: conversation.id, beforeId: firstUnreadMessageId(list, count) }
    );
  }, [conversation.id, conversation.unreadCount, list]);

  const isGroup = conversation.type === 'GROUP';
  const title = isGroup ? conversation.title ?? 'Group' : conversation.peer?.displayName ?? 'Chat';
  const peerOnline = conversation.peer ? presence[conversation.peer.id]?.online ?? conversation.peer.isOnline : false;

  // ── Read up to the newest message actually visible in the viewport ──
  // A conversation is NOT marked read merely by opening it: the read cursor
  // follows the newest rendered row the user can actually see.
  const readTargetRef = useRef<string | null>(null);
  const readSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Opening a chat marks its NOTIFICATIONS read (feed stays honest) — the
  // message read cursor still follows visibility, see below.
  const { markConversationRead } = useNotifications();
  useEffect(() => {
    markConversationRead(conversation.id);
  }, [conversation.id, markConversationRead]);

  // ── Report "actively viewing" (open-chat suppression) ──
  // While THIS tab is visibly on this conversation, the server skips
  // notification-center rows for it (message unread state is unaffected).
  // Hidden tab / switching away / unmount → idle → notifications resume.
  useEffect(() => {
    if (!socket) return;
    const report = () => {
      if (document.visibilityState === 'visible') {
        socket.emit(EVENTS.CONVERSATION_VIEWING, { conversationId: conversation.id });
      } else {
        socket.emit(EVENTS.CONVERSATION_IDLE, {});
      }
    };
    report();
    document.addEventListener('visibilitychange', report);
    return () => {
      document.removeEventListener('visibilitychange', report);
      socket.emit(EVENTS.CONVERSATION_IDLE, {});
    };
  }, [socket, conversation.id]);

  useEffect(() => {
    readTargetRef.current = null;
  }, [conversation.id]);

  const computeVisibleTarget = useCallback((): string | null => {
    const el = listRef.current;
    if (!el || list.length === 0) return null;
    const container = el.getBoundingClientRect();
    const rows = el.querySelectorAll<HTMLElement>('[data-message-id]');
    // Rows render in chronological order → the last visible row is the newest
    // message the user has actually seen.
    let target: string | null = null;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.top < container.bottom - 4 && r.bottom > container.top + 4) {
        target = row.dataset.messageId ?? null;
      }
    }
    if (target) return target;
    // Nothing measured (mid-layout): when stuck to the bottom the newest
    // message is on screen.
    return stickToBottomRef.current ? list[list.length - 1]?.id ?? null : null;
  }, [list]);

  const syncReadTarget = useCallback(() => {
    if (document.visibilityState !== 'visible' || !loaded) return;
    const target = computeVisibleTarget();
    if (!target || target === readTargetRef.current) return;
    readTargetRef.current = target;
    markRead(conversation.id, target);
  }, [computeVisibleTarget, loaded, markRead, conversation.id]);

  const scheduleReadSync = useCallback(() => {
    if (readSyncTimer.current) clearTimeout(readSyncTimer.current);
    readSyncTimer.current = setTimeout(() => {
      readSyncTimer.current = null;
      syncReadTarget();
    }, 200);
  }, [syncReadTarget]);

  useEffect(() => {
    return () => {
      if (readSyncTimer.current) clearTimeout(readSyncTimer.current);
    };
  }, []);

  // Re-evaluate when messages load/arrive, the conversation changes, or the
  // tab becomes visible again with the thread open.
  useEffect(() => {
    scheduleReadSync();
  }, [conversation.id, loaded, list.length, scheduleReadSync]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleReadSync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [scheduleReadSync]);

  // Scroll to bottom on open and on new messages
  useEffect(() => {
    if (loaded) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      stickToBottomRef.current = true;
    }
  }, [conversation.id, loaded]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [list.length, typingNames.length]);

  // userId → display info for "who reacted" labels (participants are already
  // in the conversation DTO — no extra fetch).
  const membersMap = useMemo(() => {
    const map: Record<string, { displayName: string; username?: string }> = {};
    for (const m of conversation.members ?? []) {
      map[m.user.id] = { displayName: m.user.displayName, username: m.user.username };
    }
    if (conversation.peer) {
      map[conversation.peer.id] = {
        displayName: conversation.peer.displayName,
        username: conversation.peer.username
      };
    }
    if (user) map[user.id] = { displayName: user.displayName, username: user.username };
    return map;
  }, [conversation.members, conversation.peer, user]);

  // ── Scroll to + briefly highlight a message row ──
  const flashRow = useCallback((el: HTMLElement) => {
    stickToBottomRef.current = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('bg-brand-500/[0.12]', 'transition-colors', 'rounded-xl');
    setTimeout(() => {
      el.classList.remove('bg-brand-500/[0.12]', 'transition-colors', 'rounded-xl');
    }, 2200);
  }, []);

  /**
   * Jump to a message by id (reply-quote click, notification deep link).
   * Works when the message is already loaded; if it is outside the loaded
   * window, pull older pages (bounded) to find it; give up gracefully.
   */
  const jumpToMessage = useCallback(
    (messageId: string) => {
      if (!isSafeSegment(messageId)) return;
      const find = () =>
        listRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`) ?? null;
      void (async () => {
        let el = find();
        for (let i = 0; !el && hasMoreOlder[conversation.id] && i < 10; i++) {
          await loadOlder(conversation.id);
          el = find();
        }
        if (el) flashRow(el);
        else toast.info('Original message not available', 'It may have been deleted.');
      })();
    },
    [conversation.id, hasMoreOlder, loadOlder, flashRow, toast]
  );

  // ── Deep link to a message (?message=<id>) from a notification ──
  // (placed AFTER the scroll-to-bottom effects: both run on load, and this
  // one must win.) Ids are validated and the query param is stripped after
  // handling; routing through jumpToMessage keeps both jump paths identical.
  useEffect(() => {
    if (!loaded) return;
    const params = new URLSearchParams(window.location.search);
    const targetId = params.get('message');
    if (!targetId || !isSafeSegment(targetId)) return;
    params.delete('message');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    jumpToMessage(targetId);
  }, [loaded, conversation.id, jumpToMessage]);

  useEffect(() => {
    const onKeyboard = () => {
      const el = listRef.current;
      if (!el || !stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    };
    window.addEventListener('linkup:keyboard', onKeyboard);
    return () => window.removeEventListener('linkup:keyboard', onKeyboard);
  }, []);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 120;
    setShowScrollDown(distanceFromBottom > 320);

    // Infinite scroll for older messages
    if (el.scrollTop < 80 && hasMoreOlder[conversation.id] && !loadingOlder[conversation.id]) {
      const prevHeight = el.scrollHeight;
      void loadOlder(conversation.id).then(() => {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop;
        });
      });
    }

    // Read cursor follows what is actually visible.
    scheduleReadSync();
  }, [conversation.id, hasMoreOlder, loadingOlder, loadOlder, scheduleReadSync]);

  // Mark-read is handled by the read-target sync above (read up to the newest
  // VISIBLE message) — opening a conversation alone never marks it read.

  const grouped = useMemo(() => {
    const rows: { type: 'date'; date: string }[] | any[] = [];
    const out: Array<
      | { kind: 'date'; date: string; key: string }
      | { kind: 'unread'; key: string }
      | { kind: 'message'; message: MessageDTO; showAvatar: boolean; isLastInGroup: boolean; key: string }
    > = [];

    let prev: MessageDTO | null = null;
    const filtered = searchQuery.trim()
      ? list.filter((m) => m.content?.toLowerCase().includes(searchQuery.toLowerCase()))
      : list;

    const unreadBeforeId =
      unreadAnchor && unreadAnchor.convId === conversation.id ? unreadAnchor.beforeId : null;
    let unreadInserted = false;

    for (const m of filtered) {
      const prevDate = prev ? new Date(prev.createdAt).toDateString() : null;
      const curDate = new Date(m.createdAt).toDateString();
      if (prevDate !== curDate) {
        out.push({ kind: 'date', date: m.createdAt, key: `date-${curDate}` });
      }
      if (!unreadInserted && unreadBeforeId && m.id === unreadBeforeId) {
        out.push({ kind: 'unread', key: 'unread-separator' });
        unreadInserted = true;
      }
      const sameSender = prev && prev.senderId === m.senderId && prev.type !== 'SYSTEM' && m.type !== 'SYSTEM';
      const gap =
        prev && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000;
      out.push({
        kind: 'message',
        message: m,
        showAvatar: !sameSender || Boolean(gap),
        isLastInGroup: true,
        key: m.id
      });
      if (prev && sameSender && !gap) {
        const idx = out.length - 2;
        if (idx >= 0 && out[idx]!.kind === 'message') {
          (out[idx] as any).isLastInGroup = false;
        }
      }
      prev = m;
    }
    return out;
  }, [list, searchQuery, unreadAnchor, conversation.id]);

  const headerSubtitle = isGroup
    ? `${conversation.memberCount} members${typingNames.length ? ' · typing…' : ''}`
    : peerOnline
      ? 'Online'
      : conversation.peer?.lastSeenAt
        ? `last seen ${formatRelativeLastSeen(conversation.peer.lastSeenAt)}`
        : '';

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/conversations/${conversation.id}/theme`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j.ok) setChatTheme(j.data.themeKey || 'default');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  async function saveChatTheme(themeKey: string) {
    const res = await fetch(`/api/conversations/${conversation.id}/theme`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ themeKey })
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      toast.error(json.error?.message || 'Chat themes require Premium');
      return;
    }
    setChatTheme(json.data.themeKey);
    setThemeOpen(false);
  }

  const menuItems: MenuItem[] = [
    {
      label: conversation.isMuted ? 'Unmute notifications' : 'Mute notifications',
      icon: conversation.isMuted ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />,
      onClick: async () => {
        const next = !conversation.isMuted;
        patchConversation(conversation.id, { isMuted: next });
        await fetch(`/api/conversations/${conversation.id}/mute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ muted: next }),
          credentials: 'include'
        });
        toast.success(next ? 'Conversation muted' : 'Notifications on');
      }
    },
    {
      label: conversation.isPinned ? 'Unpin chat' : 'Pin chat',
      icon: conversation.isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />,
      onClick: async () => {
        const next = !conversation.isPinned;
        patchConversation(conversation.id, { isPinned: next });
        await fetch(`/api/conversations/${conversation.id}/pin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: next }),
          credentials: 'include'
        });
      }
    },
    {
      label: conversation.isArchived ? 'Unarchive chat' : 'Archive chat',
      icon: conversation.isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />,
      onClick: async () => {
        const next = !conversation.isArchived;
        patchConversation(conversation.id, { isArchived: next });
        await fetch(`/api/conversations/${conversation.id}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: next }),
          credentials: 'include'
        });
        toast.success(next ? 'Chat archived' : 'Chat restored');
      }
    },
    {
      label: 'Chat theme',
      icon: <Palette className="h-4 w-4" />,
      onClick: () => setThemeOpen(true)
    },
    {
      label: 'Chat info',
      icon: <Info className="h-4 w-4" />,
      onClick: onOpenInfo,
      separatorBefore: true
    }
  ];

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* ── Header ── */}
      <header className="flex h-[64px] shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-surface px-2 sm:gap-3 sm:px-5">
        <button onClick={onBack} className="icon-btn shrink-0 md:hidden" aria-label="Back to chats">
          <ArrowLeft className="h-5 w-5" />
        </button>

        <Avatar
          name={title}
          src={isGroup ? conversation.avatarUrl : conversation.peer?.avatarUrl}
          size="sm"
          online={isGroup ? undefined : peerOnline}
        />
        <button onClick={onOpenInfo} className="min-w-0 flex-1 text-left">
          <p className="truncate text-[15px] font-bold text-ink">{title}</p>
          <p
            className={cn(
              'truncate text-xs',
              peerOnline ? 'font-medium text-mint-500' : 'text-muted'
            )}
          >
            {headerSubtitle}
          </p>
        </button>

        <div className="flex shrink-0 items-center">
          {onStartCall && (
            <>
              <button
                onClick={() => onStartCall('VOICE')}
                className="icon-btn"
                aria-label="Start voice call"
              >
                <Phone className="h-4.5 w-4.5" />
              </button>
              <button
                onClick={() => onStartCall('VIDEO')}
                className="icon-btn"
                aria-label="Start video call"
              >
                <Video className="h-4.5 w-4.5" />
              </button>
            </>
          )}
          <button
            onClick={() => setSearchOpen((v) => !v)}
            className="icon-btn"
            aria-label="Search in conversation"
          >
            <Search className="h-4.5 w-4.5" />
          </button>
          <Dropdown
            trigger={<MoreVertical className="h-4.5 w-4.5" />}
            items={menuItems}
            triggerProps={{ 'aria-label': 'Conversation menu' } as React.ButtonHTMLAttributes<HTMLButtonElement>}
          />
        </div>
      </header>

      {themeOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2">
          <p className="mr-1 text-xs font-semibold text-muted">Chat theme</p>
          {CHAT_THEMES.map((theme) => (
            <button
              key={theme}
              type="button"
              onClick={() => void saveChatTheme(theme)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-semibold capitalize',
                chatTheme === theme ? 'border-brand-500 text-brand-500' : 'border-border text-muted'
              )}
            >
              {theme}
            </button>
          ))}
          <button type="button" onClick={() => setThemeOpen(false)} className="ml-auto text-xs font-semibold text-muted">
            Close
          </button>
        </div>
      )}

      {/* In-chat search */}
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 animate-fade-in">
          <Search className="h-4 w-4 text-faint" aria-hidden />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search in conversation…"
            aria-label="Search in conversation"
            className="min-w-0 flex-1 bg-transparent text-base text-ink placeholder:text-faint focus:outline-none"
          />
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            className="icon-btn h-7 w-7"
            aria-label="Close search"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Messages ── */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="chat-wallpaper scroll-thin flex-1 overflow-y-auto"
        style={chatTheme !== 'default' ? chatThemeStyle(chatTheme) : wallpaperStyle(user?.settings?.wallpaper)}
        role="log"
        aria-label="Conversation messages"
      >
        {messagesError[conversation.id] && list.length === 0 ? (
          <EmptyState
            icon={<AlertCircle className="h-7 w-7" />}
            title="Could not load messages"
            description="Something went wrong while loading this conversation. Check your connection and try again."
            action={
              <button
                onClick={() => void retryMessages(conversation.id)}
                className="btn-primary h-9 px-4 text-xs"
              >
                Try again
              </button>
            }
            className="h-full"
          />
        ) : !loaded ? (
          <MessageListSkeleton />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Users className="h-7 w-7" />}
            title="No messages yet"
            description={`Say hi to ${title} and start the conversation!`}
            className="h-full"
          />
        ) : (
          <div className="flex min-h-full flex-col justify-end pb-3 pt-4">
            {hasMoreOlder[conversation.id] && (
              <div className="flex justify-center pb-2">
                <button
                  onClick={() => void loadOlder(conversation.id)}
                  className="rounded-full bg-surface px-4 py-1.5 text-xs font-semibold text-brand-500 shadow-soft hover:bg-brand-500/[0.08]"
                  disabled={loadingOlder[conversation.id]}
                >
                  {loadingOlder[conversation.id] ? 'Loading…' : 'Load older messages'}
                </button>
              </div>
            )}
            {grouped.map((row) =>
              row.kind === 'date' ? (
                <DateSeparator key={row.key} date={row.date} />
              ) : row.kind === 'unread' ? (
                <UnreadSeparator key={row.key} />
              ) : (
                <MessageBubble
                  key={row.key}
                  message={row.message}
                  isGroup={isGroup}
                  showAvatar={row.showAvatar}
                  isLastInGroup={row.isLastInGroup}
                  searchHighlight={searchQuery || undefined}
                  onReply={setReplyTo}
                  onEdit={(m) => {
                    setEditing(m);
                    setEditText(m.content ?? '');
                  }}
                  onDelete={(m, forEveryone) => {
                    if (forEveryone) setDeleteMsg(m);
                    else void deleteMessage(conversation.id, m.id, false);
                  }}
                  onReact={(m, emoji) => void toggleReaction(conversation.id, m.id, emoji)}
                  onForward={setForwardMsg}
                  onReport={setReportMsg}
                  onRetry={(m) => m.clientNonce && void retryMessage(conversation.id, m.clientNonce)}
                  onOpenMedia={(url, type) => setMedia({ url, type })}
                  onJumpToReply={jumpToMessage}
                  members={membersMap}
                />
              )
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <TypingIndicator names={typingNames} />

      {/* Scroll to bottom */}
      {showScrollDown && (
        <div className="pointer-events-none absolute bottom-28 left-1/2 z-10 -translate-x-1/2">
          <button
            onClick={() => {
              stickToBottomRef.current = true;
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-pop transition-colors hover:text-ink"
            aria-label="Scroll to latest messages"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* ── Composer ── */}
      {editing ? (
        <div className="border-t border-border bg-surface p-3">
          <p className="mb-2 text-xs font-semibold text-brand-500">Editing message</p>
          <div className="flex items-end gap-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={2}
              aria-label="Edit message"
              className="input-base flex-1 resize-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void editMessage(conversation.id, editing.id, editText.trim()).then(() =>
                    setEditing(null)
                  );
                }
                if (e.key === 'Escape') setEditing(null);
              }}
            />
            <button
              className="btn-primary h-10 px-4"
              onClick={() =>
                void editMessage(conversation.id, editing.id, editText.trim()).then(() =>
                  setEditing(null)
                )
              }
            >
              Save
            </button>
            <button className="btn-secondary h-10 px-4" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <Composer
          conversationId={conversation.id}
          onSend={async (input) => {
            await sendMessage(conversation.id, input);
          }}
          onTyping={(isTyping) => setTyping(conversation.id, isTyping)}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          enterToSend={user?.settings?.enterToSend ?? true}
        />
      )}

      {/* ── Media viewer ── */}
      <MediaViewer url={media?.url ?? null} type={media?.type ?? 'image'} onClose={() => setMedia(null)} />

      {/* ── Forward dialog ── */}
      <Modal
        open={Boolean(forwardMsg)}
        onClose={() => setForwardMsg(null)}
        title="Forward message"
        description="Choose the conversations to forward to."
        size="sm"
      >
        <div className="max-h-72 space-y-1 overflow-y-auto scroll-thin">
          {conversations
            .filter((c) => c.id !== conversation.id)
            .map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  if (forwardMsg) {
                    void forwardMessage(forwardMsg.id, [c.id]);
                    setForwardMsg(null);
                  }
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]"
              >
                <Avatar
                  name={c.type === 'GROUP' ? c.title ?? 'Group' : c.peer?.displayName ?? '?'}
                  src={c.type === 'GROUP' ? c.avatarUrl : c.peer?.avatarUrl}
                  size="sm"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {c.type === 'GROUP' ? c.title : c.peer?.displayName}
                  </p>
                  <p className="text-xs text-muted">
                    {c.type === 'GROUP' ? `${c.memberCount} members` : `@${c.peer?.username ?? ''}`}
                  </p>
                </div>
              </button>
            ))}
        </div>
      </Modal>

      {/* ── Report dialog ── */}
      <Modal
        open={Boolean(reportMsg)}
        onClose={() => setReportMsg(null)}
        title="Report message"
        description="Help us keep LINKUPCHAT safe. Your report is confidential."
        size="sm"
      >
        <div className="space-y-2">
          {['SPAM', 'HARASSMENT', 'IMPERSONATION', 'SCAM', 'INAPPROPRIATE', 'OTHER'].map((cat) => (
            <button
              key={cat}
              onClick={() => setReportCategory(cat)}
              className={cn(
                'w-full rounded-xl border px-4 py-2.5 text-left text-sm font-medium capitalize transition-colors',
                reportCategory === cat
                  ? 'border-brand-500 bg-brand-500/[0.08] text-brand-600'
                  : 'border-border text-ink hover:bg-ink/[0.04]'
              )}
            >
              {cat.toLowerCase().replace('_', ' ')}
            </button>
          ))}
          <button
            className="btn-danger mt-3 w-full"
            onClick={async () => {
              await fetch('/api/reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  category: reportCategory,
                  messageId: reportMsg?.id,
                  conversationId: conversation.id
                }),
                credentials: 'include'
              });
              toast.success('Report submitted', 'Our moderation team will review it.');
              setReportMsg(null);
            }}
          >
            <Flag className="h-4 w-4" aria-hidden /> Submit Report
          </button>
        </div>
      </Modal>

      {/* ── Delete confirm ── */}
      <ConfirmDialog
        open={Boolean(deleteMsg)}
        onClose={() => setDeleteMsg(null)}
        onConfirm={async () => {
          if (deleteMsg) await deleteMessage(conversation.id, deleteMsg.id, true);
          setDeleteMsg(null);
        }}
        title="Delete message?"
        message="This message will be deleted for everyone in the conversation. This cannot be undone."
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}
