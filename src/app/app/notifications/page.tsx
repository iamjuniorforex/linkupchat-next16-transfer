'use client';

import { CheckCheck, Bell, Trash2 } from 'lucide-react';
import { useNotifications } from '@/context/NotificationProvider';
import { NotificationList } from '@/components/notifications/NotificationList';
import { formatUnreadBadge } from '@/lib/unread';

export default function NotificationsPage() {
  const { unreadCount, markAllRead, removeNotifications, notifications } = useNotifications();
  const badge = formatUnreadBadge(unreadCount);

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500/[0.1] text-brand-500">
            <Bell className="h-4.5 w-4.5" aria-hidden />
          </span>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold text-ink">
              Notifications
              {badge && (
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand-500 px-1.5 text-[11px] font-bold text-white">
                  {badge}
                </span>
              )}
            </h1>
            <p className="text-xs text-muted">Everything you missed, newest first.</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void markAllRead()}
            disabled={unreadCount === 0}
            className="btn-secondary flex h-11 items-center gap-1.5 px-3 text-xs disabled:opacity-50"
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden />
            Mark all read
          </button>
          <button
            onClick={() => {
              if (notifications.length > 0 && window.confirm('Clear all notifications?')) {
                void removeNotifications('all');
              }
            }}
            disabled={notifications.length === 0}
            aria-label="Clear all notifications"
            title="Clear all notifications"
            className="icon-btn h-11 w-11 text-coral-500 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl">
          <NotificationList variant="page" />
        </div>
      </div>
    </div>
  );
}
