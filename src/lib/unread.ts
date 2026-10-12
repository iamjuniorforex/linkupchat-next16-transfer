import type { ConversationDTO, MessageDTO } from '../types';

/**
 * Pure unread-count math shared by chat state, navigation badges, the
 * document title, and the chat-list filter. Keeping it side-effect free makes
 * the realtime increment / read-decrement behaviour unit-testable.
 */

export const UNREAD_BADGE_CAP = 99;

/** "99+"-capped badge label, or null when there is nothing to show. */
export function formatUnreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > UNREAD_BADGE_CAP ? '99+' : String(count);
}

/** Global unread total across conversations (1:1 + groups, all memberships). */
export function sumUnread(conversations: Pick<ConversationDTO, 'unreadCount'>[]): number {
  let total = 0;
  for (const c of conversations) total += Math.max(0, c.unreadCount ?? 0);
  return total;
}

/**
 * Realtime increment: every incoming message that is not mine and not
 * deleted raises the conversation's unread count. When the conversation is
 * open and its newest messages are actually visible, the read-sync in
 * ConversationView immediately marks it read via remainingUnreadAfterRead —
 * so bumping unconditionally keeps the count honest for the scrolled-up and
 * background-tab cases too.
 */
export function bumpUnreadOnIncoming(
  current: number,
  message: Pick<MessageDTO, 'isMine' | 'deletedAt'>
): number {
  if (message.isMine || message.deletedAt) return Math.max(0, current);
  return Math.max(0, current) + 1;
}

/**
 * Read-up-to-message: unread is what remains after the message the viewer
 * actually saw. Mirrors the server cursor (lastReadAt = that message's
 * createdAt) using the locally loaded message list.
 */
export function remainingUnreadAfterRead(
  list: Pick<MessageDTO, 'isMine' | 'deletedAt' | 'createdAt' | 'id'>[],
  messageId?: string
): number {
  if (!messageId) return 0;
  const marked = list.find((m) => m.id === messageId);
  if (!marked) return 0;
  return list.filter(
    (m) => !m.isMine && !m.deletedAt && m.createdAt > marked.createdAt
  ).length;
}

/** Chat-list "Unread" filter: only conversations with something unread. */
export function passesUnreadFilter(
  conversation: Pick<ConversationDTO, 'unreadCount'>,
  filter: 'all' | 'unread'
): boolean {
  return filter === 'all' || (conversation.unreadCount ?? 0) > 0;
}

/**
 * First message id of the unread tail — the message the thread's
 * "Unread messages" divider should sit before. `unreadCount` is the count
 * captured when the thread was opened (the visibility-driven read-sync zeroes
 * the live count afterwards, so it must not be re-read here). Returns null
 * when nothing is unread or no incoming message is available to anchor to.
 */
export function firstUnreadMessageId(
  messages: Pick<MessageDTO, 'id' | 'isMine' | 'deletedAt'>[],
  unreadCount: number
): string | null {
  if (!Array.isArray(messages) || messages.length === 0 || !(unreadCount > 0)) return null;
  let remaining = unreadCount;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.isMine || m.deletedAt) continue;
    remaining -= 1;
    if (remaining === 0) return m.id;
  }
  // The unread tail extends past the loaded window — anchor to the earliest
  // visible incoming message so the divider still marks the boundary.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (!m.isMine && !m.deletedAt) return m.id;
  }
  return null;
}
