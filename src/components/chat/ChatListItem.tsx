'use client';

import { memo } from 'react';
import { Pin, BellOff, Users, Check, CheckCheck } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { cn, formatChatListTime, truncate } from '@/lib/utils';
import { formatUnreadBadge } from '@/lib/unread';
import { latestUnreadReactionEmoji } from '@/lib/notifications';
import { useNotifications } from '@/context/NotificationProvider';
import type { ConversationDTO, MessageDTO } from '@/types';

function previewText(message: MessageDTO | null, myName: string): string {
  if (!message) return 'Say hi — start the conversation!';
  const mine = message.isMine;
  const prefix = mine ? 'You: ' : '';
  if (message.deletedAt) return `${prefix}Message deleted`;
  switch (message.type) {
    case 'IMAGE':
      return `${prefix}📷 Photo`;
    case 'VIDEO':
      return `${prefix}🎥 Video`;
    case 'VOICE':
      return `${prefix}🎤 Voice message`;
    case 'AUDIO':
      return `${prefix}🎵 Audio`;
    case 'DOCUMENT':
      return `${prefix}📄 Document`;
    case 'GIF':
      return `${prefix}GIF`;
    case 'STICKER':
      return `${prefix}Sticker`;
    case 'SYSTEM':
      return message.content ?? '';
    default:
      return `${prefix}${message.content ?? ''}`;
  }
}

function DeliveryTicks({ status }: { status?: MessageDTO['status'] }) {
  if (!status || status === 'SENDING') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-label="Sending">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      </svg>
    );
  }
  if (status === 'FAILED') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-label="Failed">
        <circle cx="8" cy="8" r="7" stroke="#FF6B5E" strokeWidth="1.5" />
        <path d="M8 4.5v4.5M8 11.5h.01" stroke="#FF6B5E" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  const read = status === 'READ';
  return (
    <span aria-label={read ? 'Read' : status === 'DELIVERED' ? 'Delivered' : 'Sent'}>
      {read ? (
        <CheckCheck className="h-3.5 w-3.5 text-sky-500" />
      ) : status === 'DELIVERED' ? (
        <CheckCheck className="h-3.5 w-3.5" />
      ) : (
        <Check className="h-3.5 w-3.5" />
      )}
    </span>
  );
}

interface ChatListItemProps {
  conversation: ConversationDTO;
  active: boolean;
  onClick: () => void;
  online: boolean;
}

export const ChatListItem = memo(function ChatListItem({
  conversation,
  active,
  onClick,
  online
}: ChatListItemProps) {
  // Reaction activity is derived from unread REACTION notifications — kept
  // deliberately SEPARATE from the Phase 1 message-unread count (a reaction
  // is never counted as an unread message). Cleared by the existing
  // notification read mechanisms when the conversation is reopened.
  const { notifications } = useNotifications();
  const reactionActivity = latestUnreadReactionEmoji(notifications, conversation.id);

  const title =
    conversation.type === 'GROUP'
      ? conversation.title ?? 'Group'
      : conversation.peer?.displayName ?? 'Unknown';

  const time = conversation.lastMessageAt
    ? formatChatListTime(conversation.lastMessageAt)
    : '';

  return (
    <button
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors',
        active
          ? 'bg-brand-500/[0.1] dark:bg-brand-500/[0.16]'
          : 'hover:bg-ink/[0.04] dark:hover:bg-white/[0.05]'
      )}
    >
      {conversation.type === 'GROUP' ? (
        <div className="relative">
          <Avatar name={title} src={conversation.avatarUrl} size="md" />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-sky-500 text-white">
            <Users className="h-2.5 w-2.5" aria-hidden />
          </span>
        </div>
      ) : (
        <Avatar
          name={title}
          src={conversation.peer?.avatarUrl}
          size="md"
          online={online}
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-[15px] font-semibold text-ink">{title}</p>
          {conversation.isPinned && <Pin className="h-3 w-3 shrink-0 rotate-45 text-brand-500" aria-label="Pinned" />}
          {conversation.isMuted && <BellOff className="h-3 w-3 shrink-0 text-faint" aria-label="Muted" />}
          <span className="ml-auto shrink-0 text-[11px] font-medium text-faint">{time}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 truncate text-[13px]',
              conversation.unreadCount > 0 ? 'font-medium text-ink' : 'text-muted'
            )}
          >
            {conversation.lastMessage?.isMine && !conversation.lastMessage.deletedAt && (
              <span className="mr-1 inline-flex translate-y-0.5 text-muted">
                <DeliveryTicks status={conversation.lastMessage.status} />
              </span>
            )}
            {truncate(previewText(conversation.lastMessage, ''), 64)}
          </p>
          {conversation.unreadCount > 0 && (
            <span
              aria-label={`${conversation.unreadCount} unread messages`}
              className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand-500 px-1.5 text-[11px] font-bold text-white"
            >
              {formatUnreadBadge(conversation.unreadCount)}
            </span>
          )}
          {reactionActivity && (
            <span
              title="New reaction"
              aria-label="New reaction activity"
              className="flex h-5 min-w-[20px] items-center justify-center rounded-full border border-border bg-surface px-1 text-xs shadow-soft"
            >
              {reactionActivity}
            </span>
          )}
        </div>
      </div>
    </button>
  );
});
