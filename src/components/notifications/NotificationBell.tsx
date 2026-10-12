'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { formatUnreadBadge } from '@/lib/unread';
import { useNotifications } from '@/context/NotificationProvider';
import { NotificationList } from './NotificationList';

const PANEL_WIDTH = 368;

/**
 * Notification bell with unread badge (99+ cap) and a dropdown feed panel.
 * Distinct from the Chats unread badge — that tracks unread MESSAGES.
 */
export function NotificationBell({ align = 'end' }: { align?: 'start' | 'end' }) {
  const { unreadCount, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const badge = formatUnreadBadge(unreadCount);

  useEffect(() => {
    if (!open) return;
    const updatePos = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
      const left =
        align === 'end'
          ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
          : Math.min(rect.left, window.innerWidth - width - 8);
      setPos({ top: rect.bottom + 8, left });
    };
    updatePos();
    const onDown = (e: MouseEvent) => {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open, align]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={badge ? `Notifications (${badge} unread)` : 'Notifications'}
        aria-expanded={open}
        className="icon-btn relative"
      >
        <Bell className="h-4.5 w-4.5" aria-hidden />
        {badge && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-bold leading-none text-white shadow-pop">
            {badge}
          </span>
        )}
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            className="fixed z-50 overflow-hidden rounded-2xl border border-border bg-surface shadow-pop"
            style={{ top: pos.top, left: pos.left, width: Math.min(PANEL_WIDTH, window.innerWidth - 16) }}
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <h3 className="text-sm font-bold text-ink">Notifications</h3>
              <button
                type="button"
                onClick={() => void markAllRead()}
                disabled={unreadCount === 0}
                className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-brand-500 transition-colors hover:bg-brand-500/[0.08] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden />
                Mark all read
              </button>
            </header>

            <div className="scroll-thin max-h-[min(420px,60vh)] overflow-y-auto">
              <NotificationList variant="panel" onNavigate={() => setOpen(false)} />
            </div>

            <footer className="border-t border-border p-2">
              <Link
                href="/app/notifications"
                onClick={() => setOpen(false)}
                className="block rounded-xl px-3 py-2 text-center text-xs font-semibold text-brand-500 transition-colors hover:bg-brand-500/[0.08]"
              >
                See all notifications
              </Link>
            </footer>
          </div>,
          document.body
        )}
    </>
  );
}
