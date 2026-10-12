'use client';

import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { cn, formatChatListTime } from '@/lib/utils';
import { notificationDeepLink } from '@/lib/notifications';
import { useNotifications } from '@/context/NotificationProvider';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Skeleton';

interface NotificationListProps {
  variant?: 'panel' | 'page';
  /** Called after a notification click navigates (e.g. close the panel). */
  onNavigate?: () => void;
}

export function NotificationList({ variant = 'panel', onNavigate }: NotificationListProps) {
  const router = useRouter();
  const { notifications, loading, loaded, error, refresh, markRead } = useNotifications();

  async function handleClick(id: string, deepLink: string | null) {
    await markRead([id]);
    if (deepLink) {
      router.push(deepLink);
      onNavigate?.();
    }
  }

  if (!loaded && loading) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10" role="status" aria-live="polite">
        <Spinner label="Loading notifications…" />
        <div className="w-full space-y-2 opacity-60">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse-soft rounded-xl bg-ink/[0.05] dark:bg-white/[0.06]" />
          ))}
        </div>
      </div>
    );
  }

  if (error && notifications.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center" role="alert">
        <p className="text-sm font-semibold text-ink">Could not load notifications</p>
        <p className="text-xs text-muted">{error}</p>
        <button onClick={() => void refresh()} className="btn-secondary h-8 px-3 text-xs">
          Try again
        </button>
      </div>
    );
  }

  if (notifications.length === 0) {
    return (
      <EmptyState
        compact={variant === 'panel'}
        icon={<Bell className="h-7 w-7" />}
        title="No notifications yet"
        description="Message notifications will show up here."
      />
    );
  }

  return (
    <ul role="list" aria-label="Notifications">
      {notifications.map((n) => {
        const link = notificationDeepLink(n);
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => void handleClick(n.id, link)}
              disabled={!link}
              className={cn(
                'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.04] dark:hover:bg-white/[0.05]',
                !n.readAt && 'bg-brand-500/[0.06]',
                !link && 'cursor-default'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  n.readAt ? 'border border-border-strong' : 'bg-brand-500'
                )}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-sm',
                    n.readAt ? 'text-muted' : 'font-semibold text-ink'
                  )}
                >
                  {n.title}
                </span>
                {n.body && (
                  <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span>
                )}
                <span className="mt-1 block text-[11px] text-faint">
                  {formatChatListTime(n.createdAt)}
                </span>
              </span>
              {!n.readAt && (
                <span className="sr-only">Unread notification</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
