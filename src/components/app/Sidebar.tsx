'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Search,
  MessageSquarePlus,
  MessageCircle,
  Phone,
  Radio,
  Users,
  Settings,
  PhoneMissed,
  PhoneOutgoing,
  PhoneIncoming,
  Phone as PhoneIcon,
  Video,
  UserPlus,
  Archive,
  ChevronDown,
  Plus,
  Trash2,
  AlertCircle
} from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { Avatar } from '@/components/ui/Avatar';
import { ChatListSkeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn, formatChatListTime, formatDuration, truncate } from '@/lib/utils';
import { formatUnreadBadge, passesUnreadFilter } from '@/lib/unread';
import { useChat } from '@/context/ChatProvider';
import { useAuth } from '@/context/AuthProvider';
import { useSocket, useSocketEvent } from '@/context/SocketProvider';
import { EVENTS } from '@shared/events';
import { StatusViewer } from '@/components/status/StatusViewer';
import { splitStatusGroups } from '@/lib/status-stories';
import { useCallHistory } from '@/hooks/useCallHistory';
import { useDebouncedValue } from '@/hooks/useMediaQuery';
import { ChatListItem } from '@/components/chat/ChatListItem';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { NewChatModal } from './NewChatModal';
import type { CallRecordDTO, ContactDTO, StatusDTO } from '@/types';

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 pb-2 pt-4">
      <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-faint">{title}</h2>
      {action}
    </div>
  );
}

/* ── Status rail ── */
function StatusList() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [groups, setGroups] = useState<
    { user: StatusDTO['user']; statuses: StatusDTO[]; isMe: boolean }[]
  >([]);
  const [loaded, setLoaded] = useState(false);
  const [viewing, setViewing] = useState<{ user: StatusDTO['user']; statuses: StatusDTO[]; index: number } | null>(null);
  const [confirming, setConfirming] = useState<StatusDTO | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try {
      // Phase 5B: the feed API returns other users' statuses; mine come from
      // /api/status/me and are merged in so the rail looks unchanged.
      const [feedRes, mineRes] = await Promise.all([
        fetch('/api/status', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/status/me', { credentials: 'include' }).then((r) => r.json())
      ]);
      const others: { user: StatusDTO['user']; statuses: StatusDTO[]; isMe: boolean }[] = feedRes.ok
        ? feedRes.data.groups
        : [];
      const own: StatusDTO[] = mineRes.ok ? mineRes.data.statuses : [];
      setGroups(
        me && own.length > 0
          ? [
              {
                user: {
                  id: me.id,
                  username: me.username,
                  displayName: me.displayName,
                  avatarUrl: me.avatarUrl
                },
                statuses: own,
                isMe: true
              },
              ...others
            ]
          : others
      );
    } catch {
      /* keep the last good state */
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  // The status page's composer posts in another pane — refresh the rail.
  useEffect(() => {
    const onPosted = () => {
      void load();
    };
    window.addEventListener('linkup:status-posted', onPosted);
    return () => window.removeEventListener('linkup:status-posted', onPosted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  // A status was deleted (in this tab or on another device): refresh the
  // rail and advance the open viewer past the deleted status — to the next
  // valid one, or closed at the end.
  function handleStatusDeleted(statusId: string) {
    if (!statusId) return;
    void load();
    setViewing((v) => {
      if (!v) return v;
      const idx = v.statuses.findIndex((s) => s.id === statusId);
      if (idx === -1) return v;
      const wasCurrent = idx === v.index;
      const remaining = v.statuses.filter((s) => s.id !== statusId);
      if (remaining.length === 0) return null;
      if (!wasCurrent) {
        return {
          ...v,
          statuses: remaining,
          index: Math.max(0, Math.min(v.index - (idx < v.index ? 1 : 0), remaining.length - 1))
        };
      }
      // The status being watched is gone: the next one takes its place.
      if (v.index < remaining.length) return { ...v, statuses: remaining, index: v.index };
      // Group exhausted → continue with the next group that has statuses.
      const gi = groups.findIndex((g) => g.user?.id === v.user?.id);
      for (let j = gi + 1; j < groups.length; j++) {
        const g = groups[j]!;
        const left = g.statuses.filter((s) => s.id !== statusId);
        if (left.length > 0) return { user: g.user, statuses: left, index: 0 };
      }
      return null;
    });
  }

  useEffect(() => {
    const onDeleted = (e: Event) => {
      handleStatusDeleted((e as CustomEvent<{ statusId: string }>).detail?.statusId ?? '');
    };
    window.addEventListener('linkup:status-deleted', onDeleted);
    return () => window.removeEventListener('linkup:status-deleted', onDeleted);
  });

  useSocketEvent<{ statusId: string }>(EVENTS.STATUS_DELETED, (payload) => {
    handleStatusDeleted(payload?.statusId ?? '');
  });

  /** Tap "Add status" anywhere in the rail → the single composer on /app/status. */
  function openCompose() {
    window.dispatchEvent(new CustomEvent('linkup:compose-status'));
  }

  async function performDelete() {
    if (!confirming) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/status/${confirming.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.error?.message ?? 'Could not delete status');
      toast.success('Status deleted', 'It is gone from your updates.');
      const deletedId = confirming.id;
      setConfirming(null);
      // One local event updates the rail, the open viewer and the status page.
      window.dispatchEvent(new CustomEvent('linkup:status-deleted', { detail: { statusId: deletedId } }));
    } catch (err) {
      toast.error('Could not delete status', err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  }

  /** Next status in the viewable order (across authors); closes at the end. */
  const goNext = useCallback(() => {
    setViewing((v) => {
      if (!v) return v;
      if (v.index < v.statuses.length - 1) return { ...v, index: v.index + 1 };
      const gi = groups.findIndex((g) => g.user?.id === v.user?.id);
      for (let j = gi + 1; j < groups.length; j++) {
        const g = groups[j]!;
        if (g.statuses.length > 0) return { user: g.user, statuses: g.statuses, index: 0 };
      }
      return null;
    });
  }, [groups]);

  /** Previous status in the viewable order (across authors); stays at the first. */
  const goPrev = useCallback(() => {
    setViewing((v) => {
      if (!v) return v;
      if (v.index > 0) return { ...v, index: v.index - 1 };
      const gi = groups.findIndex((g) => g.user?.id === v.user?.id);
      for (let j = gi - 1; j >= 0; j--) {
        const g = groups[j]!;
        if (g.statuses.length > 0) return { user: g.user, statuses: g.statuses, index: g.statuses.length - 1 };
      }
      return v;
    });
  }, [groups]);

  if (!loaded) return <ChatListSkeleton />;

  return (
    <div>
      {/* Story rail */}
      <div className="flex gap-3 overflow-x-auto no-scrollbar px-4 py-3">
        {/* No statuses yet: "My status" chip itself is the add control. */}
        {!groups.some((g) => g.isMe) && (
          <button
            data-testid="rail-add-status"
            aria-label="Add status"
            onClick={openCompose}
            className="flex w-16 shrink-0 flex-col items-center gap-1.5"
          >
            <div className="relative">
              <div className="rounded-full border-2 border-dashed border-brand-500/50 p-[2.5px]">
                <div className="rounded-full bg-surface p-[2px]">
                  <Avatar name={me?.displayName ?? 'Me'} src={me?.avatarUrl} size="md" />
                </div>
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-brand-500 text-white">
                <Plus className="h-3 w-3" aria-hidden />
              </span>
            </div>
            <span className="w-full truncate text-center text-[11px] font-medium text-muted">
              My status
            </span>
          </button>
        )}
        {groups.map((g) => {
          const unviewed = g.statuses.some((s) => !s.viewedByMe);
          const chip = (
            <button
              onClick={() => setViewing({ user: g.user, statuses: g.statuses, index: 0 })}
              className={cn('flex flex-col items-center gap-1.5', g.isMe ? 'w-full' : 'w-16 shrink-0')}
              aria-label={`${g.user?.displayName}'s status updates`}
            >
              <div
                className={cn(
                  'rounded-full p-[2.5px]',
                  unviewed ? 'story-ring' : 'story-ring-viewed'
                )}
              >
                <div className="rounded-full bg-surface p-[2px]">
                  <Avatar name={g.user?.displayName ?? '?'} src={g.user?.avatarUrl} size="md" />
                </div>
              </div>
              <span className="w-full truncate text-center text-[11px] font-medium text-muted">
                {g.isMe ? 'My status' : g.user?.displayName?.split(' ')[0]}
              </span>
            </button>
          );
          if (!g.isMe) return <div key={g.user?.id} className="shrink-0">{chip}</div>;
          // With active statuses: same "My status" chip, plus an add badge so
          // posting another status is always one tap away.
          return (
            <div key={g.user?.id} className="relative flex w-16 shrink-0 flex-col items-center gap-1.5">
              {chip}
              <button
                data-testid="rail-add-status"
                aria-label="Add status"
                onClick={openCompose}
                className="absolute -right-1.5 top-0 flex h-8 w-8 items-center justify-center rounded-full border-2 border-surface bg-brand-500 text-white shadow-card after:absolute after:-inset-1 after:content-['']"
              >
                <Plus className="h-3 w-3" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>

      <SectionHeader title="Recent updates" />
      <div className="space-y-0.5 px-2 pb-4">
        {/* Always-visible add row — "My status [+ Add status]" (works on
            narrow phones where the sidebar is the whole Status screen). */}
        <div className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
          <div className="relative">
            <Avatar name={me?.displayName ?? 'Me'} src={me?.avatarUrl} size="sm" />
            <span className="absolute -bottom-0.5 -right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-surface bg-brand-500 text-white">
              <Plus className="h-2.5 w-2.5" aria-hidden />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">My status</p>
            <p className="text-xs text-muted">Share a photo, video or text update</p>
          </div>
          <button
            data-testid="list-add-status"
            aria-label="Add status"
            onClick={openCompose}
            className="btn-primary !h-9 shrink-0 !px-3 !text-xs"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add status
          </button>
        </div>
        {groups.length === 0 ? (
          <EmptyState
            compact
            icon={<Radio className="h-6 w-6" />}
            title="No status updates"
            description="Share a moment — it disappears after 24 hours."
          />
        ) : (
          [
            { title: 'Recent updates', groups: splitStatusGroups(groups).recent },
            { title: 'Viewed updates', groups: splitStatusGroups(groups).viewed }
          ]
            .filter((section) => section.groups.length > 0)
            .map((section) => (
            <div key={section.title}>
              {section.title === 'Viewed updates' && (
                <p className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted">
                  Viewed updates
                </p>
              )}
              {section.groups.map((g) => (
                <button
                  key={g.user?.id}
                  onClick={() => setViewing({ user: g.user, statuses: g.statuses, index: 0 })}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.04] dark:hover:bg-white/[0.05]"
                >
                  <div
                    className={cn(
                      'rounded-full p-[2px]',
                      g.statuses.some((s) => !s.viewedByMe) ? 'story-ring' : 'story-ring-viewed'
                    )}
                  >
                    <div className="rounded-full bg-surface p-[2px]">
                      <Avatar name={g.user?.displayName ?? '?'} src={g.user?.avatarUrl} size="sm" />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">
                      {g.isMe ? 'My status' : g.user?.displayName}
                    </p>
                    <p className="text-xs text-muted">
                      {formatChatListTime(g.statuses[0]!.createdAt)} ·{' '}
                      {g.statuses.length} update{g.statuses.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  {g.isMe && g.statuses[0]?.viewerCount !== undefined && (
                    <span className="text-xs font-semibold text-brand-500">
                      {g.statuses[0].viewerCount} 👁
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      {viewing && (
        <StatusViewer
          user={viewing.user}
          statuses={viewing.statuses}
          index={viewing.index}
          mine={viewing.user?.id === me?.id}
          onNext={goNext}
          onPrev={goPrev}
          onClose={() => setViewing(null)}
          onDelete={
            viewing.user?.id === me?.id
              ? () => setConfirming(viewing.statuses[viewing.index] ?? null)
              : undefined
          }
        />
      )}

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={performDelete}
        title="Delete this status?"
        message="It will be removed from your status and your contacts' feeds right away. This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        destructive
        loading={deleting}
      />
    </div>
  );
}

/* ── Contacts list ── */
function ContactsList({ query }: { query: string }) {
  const router = useRouter();
  const [contacts, setContacts] = useState<ContactDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [results, setResults] = useState<ContactDTO['user'][]>([]);

  useEffect(() => {
    fetch('/api/contacts', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setContacts(j.data.contacts);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const debounced = useDebouncedValue(query, 300);
  useEffect(() => {
    if (debounced.trim().length < 2) {
      setResults([]);
      return;
    }
    fetch(`/api/users/search?q=${encodeURIComponent(debounced)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setResults(j.data.users);
      })
      .catch(() => {});
  }, [debounced]);

  const filtered = contacts.filter((c) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      c.user.displayName.toLowerCase().includes(q) ||
      c.user.username.includes(q)
    );
  });

  async function startChat(username: string) {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'DIRECT', username }),
      credentials: 'include'
    });
    const json = await res.json();
    if (json.ok) {
      router.push(`/app/chats/${json.data.conversation.id}`);
    }
  }

  if (!loaded) return <ChatListSkeleton />;

  return (
    <div>
      {query.trim().length >= 2 && (
        <>
          <SectionHeader title="Search results" />
          <div className="space-y-0.5 px-2 pb-2">
            {results.length === 0 ? (
              <EmptyState compact icon={<Search className="h-6 w-6" />} title="No users found" description="Try a different name or username." />
            ) : (
              results.map((u) => (
                <button
                  key={u.id}
                  onClick={() => void startChat(u.username)}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.04] dark:hover:bg-white/[0.05]"
                >
                  <Avatar name={u.displayName} src={u.avatarUrl} size="sm" online={u.isOnline} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{u.displayName}</p>
                    <p className="truncate text-xs text-muted">@{u.username}</p>
                  </div>
                  <span className="btn-secondary !h-8 !px-3 !text-xs">
                    <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Chat
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}

      <SectionHeader
        title={`My contacts · ${filtered.length}`}
        action={
          <Link
            href="/app/contacts"
            className="inline-flex items-center py-2 text-xs font-semibold text-brand-500 hover:underline"
          >
            Manage
          </Link>
        }
      />
      <div className="space-y-0.5 px-2 pb-4">
        {filtered.length === 0 && query.trim().length < 2 ? (
          <EmptyState
            compact
            icon={<UserPlus className="h-6 w-6" />}
            title="No contacts yet"
            description="Search above to find people you know."
          />
        ) : (
          filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => void startChat(c.user.username)}
              className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.04] dark:hover:bg-white/[0.05]"
            >
              <Avatar name={c.user.displayName} src={c.user.avatarUrl} size="md" online={c.user.isOnline} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{c.user.displayName}</p>
                <p className="truncate text-xs text-muted">{c.user.about || `@${c.user.username}`}</p>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ── Call history ── */
function CallsList() {
  const toast = useToast();
  const { calls, loaded, deleteCall } = useCallHistory();
  const [pendingDelete, setPendingDelete] = useState<CallRecordDTO | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteCall(pendingDelete.id);
      toast.success('Call removed from your history');
      setPendingDelete(null);
    } catch (err) {
      toast.error('Could not remove call', (err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  if (!loaded) return <ChatListSkeleton />;

  return (
    <div>
      <SectionHeader title="Recent calls" />
      <div className="space-y-0.5 px-2 pb-4">
        {calls.length === 0 ? (
          <EmptyState
            compact
            icon={<PhoneIcon className="h-6 w-6" />}
            title="No calls yet"
            description="Start a voice or video call from any conversation."
          />
        ) : (
          calls.map((c) => {
            const missed = c.status === 'MISSED' || c.status === 'DECLINED';
            const Icon =
              c.direction === 'OUTGOING'
                ? PhoneOutgoing
                : missed
                  ? PhoneMissed
                  : PhoneIncoming;
            return (
              <div
                key={c.id}
                className="group/callrow flex items-center gap-3 rounded-2xl px-3 py-2.5"
              >
                <Avatar name={c.peer.displayName} src={c.peer.avatarUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-sm font-semibold', missed ? 'text-coral-500' : 'text-ink')}>
                    {c.peer.displayName}
                  </p>
                  <p className="flex items-center gap-1 text-xs text-muted">
                    <Icon className="h-3 w-3" aria-hidden />
                    {c.type === 'VIDEO' ? 'Video' : 'Voice'} · {formatChatListTime(c.startedAt)}
                    {c.durationSec > 0 && ` · ${formatDuration(c.durationSec)}`}
                  </p>
                </div>
                <button
                  onClick={() => setPendingDelete(c)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-faint transition-colors hover:bg-coral-500/10 hover:text-coral-500"
                  aria-label={`Remove ${c.peer.displayName} call from history`}
                  title="Remove from your history"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <Video className="h-4 w-4 text-faint" aria-hidden />
              </div>
            );
          })
        )}
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => {
          if (!deleting) setPendingDelete(null);
        }}
        onConfirm={confirmDelete}
        title="Remove from your call history?"
        message={
          pendingDelete
            ? `This removes the ${pendingDelete.type === 'VIDEO' ? 'video' : 'voice'} call with ${pendingDelete.peer.displayName} from your history only — ${pendingDelete.peer.displayName} will still see it in theirs.`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Cancel"
        destructive
        loading={deleting}
      />
    </div>
  );
}

/* ── Main sidebar ── */
export function Sidebar({ hideOnMobile }: { hideOnMobile?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { conversations, conversationsLoaded, conversationsError, totalUnread, refreshConversations } =
    useChat();
  const { connected, presence } = useSocket();
  const [query, setQuery] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [unreadFilter, setUnreadFilter] = useState<'all' | 'unread'>('all');

  const section = pathname.startsWith('/app/contacts')
    ? 'contacts'
    : pathname.startsWith('/app/calls')
      ? 'calls'
      : pathname.startsWith('/app/status')
        ? 'status'
        : pathname.startsWith('/app/settings') ||
            pathname.startsWith('/app/premium') ||
            pathname.startsWith('/app/business')
          ? 'settings'
          : 'chats';

  const activeConvId = pathname.startsWith('/app/chats/')
    ? pathname.split('/')[3] ?? null
    : null;

  const filtered = useMemo(() => {
    let list = conversations;
    if (showArchived) {
      list = list.filter((c) => c.isArchived);
    } else {
      list = list.filter((c) => !c.isArchived);
    }
    // Unread filter — All keeps existing behavior; Unread narrows the list.
    list = list.filter((c) => passesUnreadFilter(c, unreadFilter));
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter((c) => {
      const title = c.type === 'GROUP' ? c.title ?? '' : c.peer?.displayName ?? '';
      const last = c.lastMessage?.content ?? '';
      return title.toLowerCase().includes(q) || last.toLowerCase().includes(q);
    });
  }, [conversations, query, showArchived, unreadFilter]);

  const navItems = [
    { href: '/app/chats', label: 'Chats', icon: MessageCircle },
    { href: '/app/calls', label: 'Calls', icon: Phone },
    { href: '/app/status', label: 'Status', icon: Radio },
    { href: '/app/contacts', label: 'Contacts', icon: Users },
    { href: '/app/settings', label: 'Settings', icon: Settings }
  ];

  return (
    <aside
      className={cn(
        'flex h-full w-full flex-col border-r border-border bg-surface md:w-[360px] md:shrink-0',
        hideOnMobile && 'hidden md:flex'
      )}
      aria-label="Main navigation"
    >
      {/* Header */}
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <Link href="/app/chats" aria-label="LINKUPCHAT chats">
            <Logo size="sm" />
          </Link>
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
                connected ? 'bg-mint-500/12 text-mint-600' : 'bg-gold-500/15 text-gold-500'
              )}
              title={connected ? 'Connected to realtime server' : 'Reconnecting…'}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-mint-500' : 'bg-gold-500 animate-pulse-soft')} />
              {connected ? 'Live' : 'Connecting…'}
            </span>
            <ThemeToggle />
            <NotificationBell />
            <button
              onClick={() => setNewChatOpen(true)}
              className="icon-btn bg-brand-500/[0.1] text-brand-500 hover:bg-brand-500/[0.18]"
              aria-label="New chat"
            >
              <MessageSquarePlus className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        <div className="relative mt-3">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              section === 'chats'
                ? 'Search chats…'
                : section === 'contacts'
                  ? 'Search people…'
                  : 'Search…'
            }
            aria-label="Search"
            className="input-base !rounded-full !py-2 pl-10"
          />
        </div>

        {/* Chat list filters */}
        {section === 'chats' && (
          <div className="mt-2.5 flex items-center gap-1.5" role="group" aria-label="Chat list filter">
            {([
              ['all', 'All'],
              ['unread', 'Unread']
            ] as const).map(([f, label]) => (
              <button
                key={f}
                onClick={() => setUnreadFilter(f)}
                aria-pressed={unreadFilter === f}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold transition-colors',
                  unreadFilter === f
                    ? 'bg-brand-500 text-white'
                    : 'text-muted hover:bg-ink/[0.05] dark:hover:bg-white/[0.07]'
                )}
              >
                {label}
                {f === 'unread' && totalUnread > 0 && (
                  <span
                    className={cn(
                      'flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold',
                      unreadFilter === f
                        ? 'bg-white/25 text-white'
                        : 'bg-brand-500/15 text-brand-600 dark:text-brand-300'
                    )}
                  >
                    {formatUnreadBadge(totalUnread)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Desktop nav pills */}
        <nav className="mt-3 hidden gap-1 overflow-x-auto no-scrollbar md:flex" aria-label="Sections">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
                section === item.label.toLowerCase()
                  ? 'bg-brand-500 text-white'
                  : 'text-muted hover:bg-ink/[0.05] dark:hover:bg-white/[0.07]'
              )}
            >
              <item.icon className="h-3.5 w-3.5" aria-hidden />
              {item.label}
              {item.href === '/app/chats' && totalUnread > 0 && (
                <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-coral-500 px-1 text-[10px] font-bold text-white">
                  {formatUnreadBadge(totalUnread)}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </div>

      {/* Body */}
      <div className="scroll-thin flex-1 overflow-y-auto">
        {section === 'chats' && (
          <>
            {!conversationsLoaded ? (
              <ChatListSkeleton />
            ) : conversationsError && filtered.length === 0 ? (
              <EmptyState
                icon={<AlertCircle className="h-7 w-7" />}
                title="Couldn't load your chats"
                description="Check your connection and try again."
                action={
                  <button
                    onClick={() => void refreshConversations()}
                    className="btn-primary h-9 px-4 text-xs"
                  >
                    Try again
                  </button>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<MessageCircle className="h-7 w-7" />}
                title={
                  query
                    ? 'No chats found'
                    : unreadFilter === 'unread'
                      ? 'No unread chats'
                      : showArchived
                        ? 'No archived chats'
                        : 'No conversations yet'
                }
                description={
                  query
                    ? 'Try a different search term.'
                    : unreadFilter === 'unread'
                      ? 'You are all caught up.'
                      : 'Search for someone to start chatting.'
                }
                action={
                  !query && !showArchived && unreadFilter === 'all' ? (
                    <button onClick={() => setNewChatOpen(true)} className="btn-primary h-9 px-4 text-xs">
                      <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden /> Start a chat
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="space-y-0.5 px-2 pb-4">
                {filtered.map((c) => (
                  <ChatListItem
                    key={c.id}
                    conversation={c}
                    active={c.id === activeConvId}
                    online={c.peer ? (presence[c.peer.id]?.online ?? c.peer.isOnline) : false}
                    onClick={() => router.push(`/app/chats/${c.id}`)}
                  />
                ))}
                <button
                  onClick={() => setShowArchived((v) => !v)}
                  className="mx-auto mt-3 flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <Archive className="h-3.5 w-3.5" aria-hidden />
                  {showArchived ? 'Back to chats' : 'Archived chats'}
                  <ChevronDown className={cn('h-3 w-3 transition-transform', showArchived && 'rotate-180')} />
                </button>
              </div>
            )}
          </>
        )}
        {section === 'contacts' && <ContactsList query={query} />}
        {section === 'calls' && <CallsList />}
        {section === 'status' && <StatusList />}
        {section === 'settings' && (
          <div className="space-y-3 px-3 py-4">
            <EmptyState
              compact
              icon={<Settings className="h-6 w-6" />}
              title="Settings"
              description="Manage your account, privacy and preferences."
            />
            <div className="grid gap-2">
              <Link href="/app/premium" className="rounded-2xl border border-border px-4 py-3 text-sm font-semibold text-ink hover:bg-ink/[0.04]">
                LINKUPCHAT Premium
              </Link>
              <Link href="/app/business" className="rounded-2xl border border-border px-4 py-3 text-sm font-semibold text-ink hover:bg-ink/[0.04]">
                LINKUPCHAT Business
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Footer profile */}
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-2xl px-2 py-1.5">
          <Link href={`/app/u/${user?.username ?? ''}`}>
            <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} size="sm" online />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{user?.displayName}</p>
            <p className="truncate text-xs text-muted">@{user?.username}</p>
          </div>
          <button
            onClick={() => void logout()}
            className="text-xs font-semibold text-muted transition-colors hover:text-coral-500"
          >
            Log out
          </button>
        </div>
      </div>

      <NewChatModal open={newChatOpen} onClose={() => setNewChatOpen(false)} />
    </aside>
  );
}
