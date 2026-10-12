'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { useRouter } from 'next/navigation';
import { EVENTS } from '@shared/events';
import type { NotificationDTO } from '@/types';
import { useSocket, useSocketEvent } from './SocketProvider';
import { useAuth } from './AuthProvider';
import { isCallSoundActive } from '@/lib/call-sounds';
import { playNotificationSound } from '@/lib/notification-sound';
import {
  applyReadToNotifications,
  badgeCount,
  countUnreadNotifications,
  ingestRealtimeNotification,
  mergeNotifications,
  notificationsForConversation,
  shouldPlayNotificationSound
} from '@/lib/notifications';

interface NotificationContextValue {
  notifications: NotificationDTO[];
  /** Server-derived unread notification count (independent of message unreads). */
  unreadCount: number;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  markConversationRead: (conversationId: string) => Promise<void>;
  removeNotifications: (ids: string[] | 'all') => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  useSocket();
  const { user } = useAuth();
  const router = useRouter();
  const soundsEnabled = user?.settings?.notifSounds !== false && user?.settings?.notifEnabled !== false;
  const soundsRef = useRef(soundsEnabled);
  const lastSoundAt = useRef<number | null>(null);
  const [notifications, setNotifications] = useState<NotificationDTO[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;

  // ── Fetch / reconcile with server truth ──
  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/notifications', { credentials: 'include' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? 'Could not load notifications');
      const list = (json.data?.notifications ?? []) as NotificationDTO[];
      // Server is the source of truth on refresh (keeps ids stable across reloads).
      setNotifications(mergeNotifications([], list));
      setUnreadCount(Number(json.data?.unreadCount ?? countUnreadNotifications(list)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notifications');
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    soundsRef.current = soundsEnabled;
  }, [soundsEnabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const n = badgeCount(unreadCount);
    if (n === 0) void nav.clearAppBadge?.().catch(() => {});
    else void nav.setAppBadge?.(n).catch(() => {});
  }, [unreadCount]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (!data || data.type !== 'linkup:navigate' || typeof data.url !== 'string') return;
      if (!data.url.startsWith('/app/') && data.url !== '/app') return;
      router.push(data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [router]);

  // ── Realtime: merge without duplicates ──
  useSocketEvent<NotificationDTO>(EVENTS.NOTIFICATION_NEW, (n) => {
    if (!n?.id) return;
    // Same id = replay OR aggregation roll-up → replaced in place, never
    // duplicated, never double-counted (ingestRealtimeNotification).
    const before = notificationsRef.current;
    const { list, unreadDelta } = ingestRealtimeNotification(before, n);
    if (list !== before) setNotifications(list);
    if (unreadDelta) setUnreadCount((c) => c + unreadDelta);
    const now = Date.now();
    if (
      shouldPlayNotificationSound({
        soundsEnabled: soundsRef.current,
        isNew: unreadDelta > 0,
        documentHidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
        callSoundActive: isCallSoundActive(),
        lastPlayedAt: lastSoundAt.current,
        now
      })
    ) {
      lastSoundAt.current = now;
      playNotificationSound(now);
    }
  });

  useSocketEvent<{ ids: string[] | 'all'; readAt?: string }>(EVENTS.NOTIFICATION_READ, (payload) => {
    if (!payload || (payload.ids !== 'all' && !Array.isArray(payload.ids))) return;
    const readAt = payload.readAt ?? new Date().toISOString();
    const next = applyReadToNotifications(notificationsRef.current, payload.ids, readAt);
    setNotifications(next);
    setUnreadCount(countUnreadNotifications(next));
  });

  // ── Reaction removals prune their notification rows ──
  // The server deletes the REACTION row; connected clients drop it from the
  // feed via this existing MESSAGE_REACTION event (no parallel system).
  useSocketEvent<{ messageId: string; userId: string; reacted: boolean }>(
    EVENTS.MESSAGE_REACTION,
    (p) => {
      if (p?.reacted) return; // add/change arrive as NOTIFICATION_NEW (same id)
      const before = notificationsRef.current;
      const keep = before.filter(
        (n) =>
          !(
            n.type === 'REACTION' &&
            n.data?.messageId === p.messageId &&
            n.data?.reactorId === p.userId
          )
      );
      if (keep.length !== before.length) {
        const removedUnread = before.filter(
          (n) => !n.readAt && !keep.includes(n)
        ).length;
        setNotifications(keep);
        if (removedUnread) setUnreadCount((c) => Math.max(0, c - removedUnread));
      }
    }
  );

  // ── Reconnect: refetch/reconcile from the server ──
  const seenFirstConnect = useRef(false);
  useSocketEvent('connect', () => {
    if (!seenFirstConnect.current) {
      seenFirstConnect.current = true;
      return;
    }
    void refresh();
  });

  const markRead = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const before = notificationsRef.current;
    const newlyRead = before.filter((n) => !n.readAt && ids.includes(n.id)).length;
    setNotifications((prev) => applyReadToNotifications(prev, ids));
    setUnreadCount((c) => Math.max(0, c - newlyRead));
    const res = await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      credentials: 'include'
    }).catch(() => null);
    if (!res?.ok) void refresh(); // reconcile on failure
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => applyReadToNotifications(prev, 'all'));
    setUnreadCount(0);
    const res = await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
      credentials: 'include'
    }).catch(() => null);
    if (!res?.ok) void refresh();
  }, [refresh]);

  const markConversationRead = useCallback(
    async (conversationId: string) => {
      const before = notificationsRef.current;
      const affected = notificationsForConversation(before, conversationId);
      const newlyRead = affected.filter((n) => !n.readAt).length;
      if (newlyRead > 0) {
        setNotifications((prev) =>
          applyReadToNotifications(prev, affected.map((n) => n.id))
        );
        setUnreadCount((c) => Math.max(0, c - newlyRead));
      }
      // Server-side too (covers notifications outside the loaded window).
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId }),
        credentials: 'include'
      }).catch(() => {});
    },
    []
  );

  const removeNotifications = useCallback(
    async (ids: string[] | 'all') => {
      const before = notificationsRef.current;
      const removing =
        ids === 'all' ? before : before.filter((n) => ids.includes(n.id));
      const removedUnread = removing.filter((n) => !n.readAt).length;
      setNotifications((prev) =>
        ids === 'all' ? [] : prev.filter((n) => !ids.includes(n.id))
      );
      setUnreadCount((c) => Math.max(0, c - removedUnread));
      const res = await fetch('/api/notifications', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids === 'all' ? { all: true } : { ids }),
        credentials: 'include'
      }).catch(() => null);
      if (!res?.ok) void refresh();
    },
    [refresh]
  );

  const value = useMemo<NotificationContextValue>(
    () => ({
      notifications,
      unreadCount,
      loading,
      loaded,
      error,
      refresh,
      markRead,
      markAllRead,
      markConversationRead,
      removeNotifications
    }),
    [
      notifications,
      unreadCount,
      loading,
      loaded,
      error,
      refresh,
      markRead,
      markAllRead,
      markConversationRead,
      removeNotifications
    ]
  );

  return (
    <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}
