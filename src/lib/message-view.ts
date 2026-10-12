import type { MessageDTO } from '../types';

/**
 * Resolve a broadcast message payload for the viewing user.
 *
 * MESSAGE_NEW / MESSAGE_UPDATED are emitted to a whole conversation room with a
 * single payload serialized against the SENDER's id, so per-viewer fields
 * cannot be computed server-side. Every client derives `isMine` from
 * `senderId` and the logged-in user's id here, BEFORE the message enters chat
 * state — that keeps bubble alignment (and the unread / delivery logic keyed
 * on `isMine`) correct for each recipient while `senderId` stays the actual
 * sender.
 */
export function resolveMessageForViewer(
  message: MessageDTO,
  viewerId: string | null | undefined
): MessageDTO {
  return {
    ...message,
    isMine: Boolean(viewerId) && message.senderId === viewerId
  };
}
