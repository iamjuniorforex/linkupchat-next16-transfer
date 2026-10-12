'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageCircle, Phone, Radio, Users, Settings, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChat } from '@/context/ChatProvider';
import { useNotifications } from '@/context/NotificationProvider';
import { formatUnreadBadge } from '@/lib/unread';

const items = [
  { href: '/app/chats', label: 'Chats', icon: MessageCircle },
  { href: '/app/calls', label: 'Calls', icon: Phone },
  { href: '/app/status', label: 'Status', icon: Radio },
  { href: '/app/contacts', label: 'Contacts', icon: Users },
  { href: '/app/notifications', label: 'Alerts', icon: Bell },
  { href: '/app/settings', label: 'Settings', icon: Settings }
];

export function BottomNav({ hidden }: { hidden?: boolean }) {
  const pathname = usePathname();
  // Chats badge = unread MESSAGES (Phase 1). Alerts badge = unread
  // notifications. They are deliberately separate.
  const { totalUnread } = useChat();
  const { unreadCount: unreadNotifications } = useNotifications();

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'h-nav fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-safe pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)] backdrop-blur-xl md:hidden',
        hidden && 'hidden'
      )}
    >
      <div className="mx-auto flex h-16 max-w-lg items-stretch justify-around">
        {items.map((item) => {
          const active =
            item.href === '/app/chats'
              ? pathname.startsWith('/app/chats')
              : pathname.startsWith(item.href);
          const badge =
            item.href === '/app/chats'
              ? formatUnreadBadge(totalUnread)
              : item.href === '/app/notifications'
                ? formatUnreadBadge(unreadNotifications)
                : null;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              aria-label={
                badge && item.href === '/app/notifications'
                  ? `Alerts (${badge} unread)`
                  : undefined
              }
              className={cn(
                'flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-[10px] font-semibold transition-colors',
                active ? 'text-brand-500' : 'text-muted hover:text-ink'
              )}
            >
              <span
                className={cn(
                  'relative flex h-8 w-14 items-center justify-center rounded-full transition-colors',
                  active && 'bg-brand-500/[0.12]'
                )}
              >
                <item.icon className="h-5 w-5" aria-hidden />
                {badge && (
                  <span
                    className={cn(
                      'absolute -top-1 right-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white shadow-pop',
                      item.href === '/app/notifications' ? 'bg-brand-500' : 'bg-coral-500'
                    )}
                  >
                    {badge}
                  </span>
                )}
              </span>
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
