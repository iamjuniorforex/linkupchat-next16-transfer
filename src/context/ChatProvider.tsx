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
import { EVENTS, type TypingPayload } from '@shared/events';
import type { ConversationDTO, MessageDTO } from '@/types';
import { useAuth } from './AuthProvider';
import { useSocket, useSocketEvent } from './SocketProvider';
import { useToast } from '@/components/ui/Toast';
import { applyReactionToggle, generateIdempotencyKey } from '@/lib/utils';
import { resolveMessageForViewer } from '@/lib/message-view';
import { bumpUnreadOnIncoming, remainingUnreadAfterRead, sumUnread } from '@/lib/unread';

interface SendMessageInput {
  type?: MessageDTO['type'];
  content?: string;
  attachmentIds?: string[];
  replyToId?: string;
}

interface ChatContextValue {
  conversations: ConversationDTO[];
  conversationsLoaded: boolean;
  /** True when the last conversations fetch failed and no data is available. */
  conversationsError: boolean;
  activeId: string | null;
  setActive: (id: string | null) => void;
  activeConversation: ConversationDTO | null;

  messages: Record<string, MessageDTO[]>;
  messagesLoaded: Record<string, boolean>;
  hasMoreOlder: Record<string, boolean>;
  loadingOlder: Record<string, boolean>;
  loadOlder: (conversationId: string) => Promise<void>;
  /** Per-conversation message-load failure flag (drives the thread error state). */
  messagesError: Record<string, boolean>;
  /** Clear a message-load error and fetch the thread again. */
  retryMessages: (conversationId: string) => Promise<void>;

  sendMessage: (conversationId: string, input: SendMessageInput) => Promise<void>;
  retryMessage: (conversationId: string, clientNonce: string) => Promise<void>;
  editMessage: (conversationId: string, messageId: string, content: string) => Promise<void>;
  deleteMessage: (conversationId: string, messageId: string, forEveryone: boolean) => Promise<void>;
  toggleReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  forwardMessage: (messageId: string, conversationIds: string[]) => Promise<void>;
  markRead: (conversationId: string, messageId?: string) => void;

  typing: Record<string, string[]>;
  setTyping: (conversationId: string, isTyping: boolean) => void;

  /** Global unread total across all conversations (1:1 + groups). */
  totalUnread: number;

  refreshConversations: () => Promise<void>;
  upsertConversation: (conversation: ConversationDTO) => void;
  patchConversation: (conversationId: string, patch: Partial<ConversationDTO>) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { socket } = useSocket();
  const toast = useToast();

  const [conversations, setConversations] = useState<ConversationDTO[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [conversationsError, setConversationsError] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, MessageDTO[]>>({});
  const [messagesLoaded, setMessagesLoaded] = useState<Record<string, boolean>>({});
  const [hasMoreOlder, setHasMoreOlder] = useState<Record<string, boolean>>({});
  const [loadingOlder, setLoadingOlder] = useState<Record<string, boolean>>({});
  const [messagesError, setMessagesError] = useState<Record<string, boolean>>({});
  const [typing, setTypingMap] = useState<Record<string, string[]>>({});

  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const deliverAckTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const cursorRef = useRef<Record<string, string | null>>({});
  const userRef = useRef(user);
  userRef.current = user;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const messagesLoadedRef = useRef(messagesLoaded);
  messagesLoadedRef.current = messagesLoaded;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // ── Conversations list ──
  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', { credentials: 'include' });
      const json = await res.json();
      if (json.ok) {
        setConversations(json.data.conversations as ConversationDTO[]);
        setConversationsError(false);
      } else {
        setConversationsError(true);
      }
    } catch {
      // Surfaced by the sidebar error state (stale data, if any, stays visible).
      setConversationsError(true);
    } finally {
      setConversationsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (user) void refreshConversations();
  }, [user, refreshConversations]);

  const upsertConversation = useCallback((conversation: ConversationDTO) => {
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conversation.id);
      if (idx === -1) return [conversation, ...prev];
      const next = [...prev];
      next[idx] = { ...next[idx]!, ...conversation };
      return next;
    });
  }, []);

  const patchConversation = useCallback((conversationId: string, patch: Partial<ConversationDTO>) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, ...patch } : c))
    );
  }, []);

  // ── Messages ──
  const loadMessages = useCallback(
    async (conversationId: string) => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages?limit=30`, {
          credentials: 'include'
        });
        const json = await res.json();
        if (json.ok) {
          const list = json.data.messages as MessageDTO[];
          cursorRef.current[conversationId] = json.data.nextCursor;
          setMessages((prev) => ({ ...prev, [conversationId]: list }));
          setMessagesLoaded((prev) => ({ ...prev, [conversationId]: true }));
          setHasMoreOlder((prev) => ({ ...prev, [conversationId]: Boolean(json.data.nextCursor) }));
          setMessagesError((prev) => ({ ...prev, [conversationId]: false }));
        } else {
          setMessagesError((prev) => ({ ...prev, [conversationId]: true }));
        }
      } catch {
        // Surfaced as the thread's inline error state (keeps the list intact).
        setMessagesError((prev) => ({ ...prev, [conversationId]: true }));
        toast.error('Something went wrong', 'Could not load messages.');
      }
    },
    [toast]
  );

  const retryMessages = useCallback(
    async (conversationId: string) => {
      setMessagesError((prev) => ({ ...prev, [conversationId]: false }));
      await loadMessages(conversationId);
    },
    [loadMessages]
  );

  const loadOlder = useCallback(
    async (conversationId: string) => {
      const cursor = cursorRef.current[conversationId];
      if (!cursor || loadingOlder[conversationId]) return;
      setLoadingOlder((prev) => ({ ...prev, [conversationId]: true }));
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/messages?limit=30&cursor=${encodeURIComponent(cursor)}`,
          { credentials: 'include' }
        );
        const json = await res.json();
        if (json.ok) {
          const older = json.data.messages as MessageDTO[];
          cursorRef.current[conversationId] = json.data.nextCursor;
          setMessages((prev) => ({
            ...prev,
            [conversationId]: [...older, ...(prev[conversationId] ?? [])]
          }));
          setHasMoreOlder((prev) => ({
            ...prev,
            [conversationId]: Boolean(json.data.nextCursor)
          }));
        }
      } finally {
        setLoadingOlder((prev) => ({ ...prev, [conversationId]: false }));
      }
    },
    [loadingOlder]
  );

  const setActive = useCallback(
    (id: string | null) => {
      setActiveId(id);
      if (id && !messagesLoaded[id]) void loadMessages(id);
    },
    [messagesLoaded, loadMessages]
  );

  const appendMessage = useCallback((message: MessageDTO) => {
    setMessages((prev) => {
      const list = prev[message.conversationId] ?? [];
      // Dedupe: real id or matching client nonce (optimistic echo)
      const withoutDupes = list.filter(
        (m) =>
          m.id !== message.id &&
          !(message.clientNonce && m.clientNonce === message.clientNonce)
      );
      return {
        ...prev,
        [message.conversationId]: [...withoutDupes, message]
      };
    });

    // Bump conversation preview
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === message.conversationId);
      if (idx === -1) return prev;
      const conv = { ...prev[idx]! };
      conv.lastMessage = message;
      conv.lastMessageAt = message.createdAt;
      conv.unreadCount = bumpUnreadOnIncoming(conv.unreadCount ?? 0, message);
      const next = [...prev];
      next.splice(idx, 1);
      // pinned conversations float anyway via sort below
      return sortConversations([conv, ...next]);
    });
  }, []);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const updateMessage = useCallback(
    (conversationId: string, messageId: string, patch: Partial<MessageDTO>) => {
      setMessages((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] ?? []).map((m) =>
          m.id === messageId ? { ...m, ...patch } : m
        )
      }));
    },
    []
  );

  // ── Send ──
  const sendMessage = useCallback(
    async (conversationId: string, input: SendMessageInput) => {
      const nonce = generateIdempotencyKey();
      const me = userRef.current;
      const optimistic: MessageDTO = {
        id: `temp-${nonce}`,
        conversationId,
        senderId: me?.id ?? null,
        sender: me
          ? {
              id: me.id,
              username: me.username,
              displayName: me.displayName,
              avatarUrl: me.avatarUrl
            }
          : null,
        type: input.type ?? 'TEXT',
        content: input.content ?? null,
        clientNonce: nonce,
        replyToId: input.replyToId ?? null,
        replyTo: null,
        attachments: [],
        reactions: [],
        editedAt: null,
        deletedAt: null,
        pinnedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'SENDING',
        readBy: [],
        isMine: true
      };

      setMessages((prev) => ({
        ...prev,
        [conversationId]: [...(prev[conversationId] ?? []), optimistic]
      }));

      // stop typing indicator locally
      setTypingMap((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] ?? []).filter((n) => n !== me?.displayName)
      }));

      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: input.type ?? 'TEXT',
            content: input.content,
            attachmentIds: input.attachmentIds,
            replyToId: input.replyToId,
            clientNonce: nonce
          }),
          credentials: 'include'
        });
        const json = await res.json();
        if (!json.ok) {
          throw new Error(json.error?.message ?? 'Message failed to send');
        }
        const message = json.data.message as MessageDTO;
        setMessages((prev) => ({
          ...prev,
          [conversationId]: (prev[conversationId] ?? []).map((m) =>
            m.clientNonce === nonce ? message : m
          )
        }));
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === conversationId);
          if (idx === -1) return prev;
          const conv = { ...prev[idx]! };
          conv.lastMessage = message;
          conv.lastMessageAt = message.createdAt;
          const next = [...prev];
          next.splice(idx, 1);
          return sortConversations([conv, ...next]);
        });
        setTyping(conversationId, false);
      } catch (err) {
        setMessages((prev) => ({
          ...prev,
          [conversationId]: (prev[conversationId] ?? []).map((m) =>
            m.clientNonce === nonce ? { ...m, status: 'FAILED' } : m
          )
        }));
        toast.error('Message failed to send', err instanceof Error ? err.message : 'Try again.');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast]
  );

  const retryMessage = useCallback(
    async (conversationId: string, clientNonce: string) => {
      const list = messages[conversationId] ?? [];
      const failed = list.find((m) => m.clientNonce === clientNonce);
      if (!failed) return;
      updateMessage(conversationId, failed.id, { status: 'SENDING' });
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: failed.type,
            content: failed.content,
            replyToId: failed.replyToId,
            clientNonce
          }),
          credentials: 'include'
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error?.message ?? 'Message failed to send');
        setMessages((prev) => ({
          ...prev,
          [conversationId]: (prev[conversationId] ?? []).map((m) =>
            m.clientNonce === clientNonce ? (json.data.message as MessageDTO) : m
          )
        }));
      } catch {
        updateMessage(conversationId, failed.id, { status: 'FAILED' });
        toast.error('Message failed to send', 'Try again.');
      }
    },
    [messages, updateMessage, toast]
  );

  const editMessage = useCallback(
    async (conversationId: string, messageId: string, content: string) => {
      const res = await fetch(`/api/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        credentials: 'include'
      });
      const json = await res.json();
      if (json.ok) {
        updateMessage(conversationId, messageId, {
          content,
          editedAt: json.data.message.editedAt
        });
      } else {
        toast.error('Could not edit message', json.error?.message);
      }
    },
    [updateMessage, toast]
  );

  const deleteMessage = useCallback(
    async (conversationId: string, messageId: string, forEveryone: boolean) => {
      if (forEveryone) {
        const res = await fetch(`/api/messages/${messageId}`, {
          method: 'DELETE',
          credentials: 'include'
        });
        const json = await res.json();
        if (json.ok) {
          updateMessage(conversationId, messageId, {
            deletedAt: new Date().toISOString(),
            content: null,
            attachments: [],
            reactions: []
          });
          return;
        }
        toast.error('Could not delete message', json.error?.message);
        return;
      }
      // Delete for me — remove locally (visibility scoped to this device)
      setMessages((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] ?? []).filter((m) => m.id !== messageId)
      }));
    },
    [updateMessage, toast]
  );

  const toggleReaction = useCallback(
    async (conversationId: string, messageId: string, emoji: string) => {
      // Optimistic update — one reaction per user (replace / remove), using
      // the same pure semantics the server enforces.
      let rolledBack: MessageDTO | undefined;
      setMessages((prev) => {
        const list = prev[conversationId] ?? [];
        const msg = list.find((m) => m.id === messageId);
        if (!msg) return prev;
        rolledBack = msg;
        const reactions = applyReactionToggle(msg.reactions, userRef.current?.id, emoji);
        return {
          ...prev,
          [conversationId]: list.map((m) => (m.id === messageId ? { ...m, reactions } : m))
        };
      });

      try {
        const res = await fetch(`/api/messages/${messageId}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji }),
          credentials: 'include'
        });
        const json = await res.json();
        if (!json.ok) throw new Error('failed');
      } catch {
        if (rolledBack) {
          setMessages((prev) => ({
            ...prev,
            [conversationId]: (prev[conversationId] ?? []).map((m) =>
              m.id === messageId ? rolledBack! : m
            )
          }));
        }
        toast.error('Could not update reaction', 'Try again.');
      }
    },
    [toast]
  );

  const forwardMessage = useCallback(
    async (messageId: string, conversationIds: string[]) => {
      const res = await fetch(`/api/messages/${messageId}/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationIds }),
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error('Could not forward message', json.error?.message);
        return;
      }
      toast.success(
        `Forwarded to ${conversationIds.length} chat${conversationIds.length === 1 ? '' : 's'}`
      );
      // socket events will refresh previews; refresh list for immediate feedback
      void refreshConversations();
    },
    [toast, refreshConversations]
  );

  // ── Read receipts (read up to message) ──
  const markRead = useCallback((conversationId: string, messageId?: string) => {
    // Local: unread is whatever remains after the message the user actually
    // saw (mirrors the server cursor = that message's createdAt).
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== conversationId) return c;
        return {
          ...c,
          unreadCount: remainingUnreadAfterRead(messagesRef.current[conversationId] ?? [], messageId)
        };
      })
    );
    // AUTHORITATIVE persistence: HTTP only (see /api/conversations/[id]/read).
    // The room's MESSAGE_READ broadcast is emitted by that route exactly once;
    // the client must not also emit MESSAGE_READ on the socket.
    fetch(`/api/conversations/${conversationId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
      credentials: 'include'
    }).catch(() => {});
  }, []);

  // ── Typing ──
  const setTyping = useCallback(
    (conversationId: string, isTyping: boolean) => {
      if (!socket) return;
      if (isTyping) {
        socket.emit(EVENTS.TYPING_START, { conversationId });
        const existing = typingTimers.current[conversationId];
        if (existing) clearTimeout(existing);
        typingTimers.current[conversationId] = setTimeout(() => {
          socket.emit(EVENTS.TYPING_STOP, { conversationId });
        }, 2500);
      } else {
        socket.emit(EVENTS.TYPING_STOP, { conversationId });
        const existing = typingTimers.current[conversationId];
        if (existing) clearTimeout(existing);
      }
    },
    [socket]
  );

  // ── Reconnect catch-up ──
  // Merge a fresh page into a loaded thread without duplicating optimistic
  // echoes (clientNonce) or overlapping API/socket copies (id).
  const reconcileMessages = useCallback(async (conversationId: string) => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages?limit=30`, {
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) return;
      const fresh = json.data.messages as MessageDTO[];
      setMessages((prev) => {
        const existing = prev[conversationId];
        if (!existing) return prev;
        const byKey = new Map<string, MessageDTO>();
        for (const m of fresh) byKey.set(m.clientNonce || m.id, m);
        for (const m of existing) {
          const key = m.clientNonce || m.id;
          if (!byKey.has(key)) byKey.set(key, m);
        }
        const merged = Array.from(byKey.values()).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt)
        );
        return { ...prev, [conversationId]: merged };
      });
    } catch {
      // best-effort; the next interaction refetches anyway
    }
  }, []);

  // Debounced delivery ack — one per conversation burst, not per message.
  const ackDelivered = useCallback(
    (conversationId: string) => {
      const existing = deliverAckTimers.current[conversationId];
      if (existing) clearTimeout(existing);
      deliverAckTimers.current[conversationId] = setTimeout(() => {
        delete deliverAckTimers.current[conversationId];
        socket?.emit(EVENTS.MESSAGE_DELIVERED, { conversationId });
      }, 300);
    },
    [socket]
  );

  // ── Socket subscriptions ──
  useSocketEvent<MessageDTO>(EVENTS.MESSAGE_NEW, (message) => {
    if (!message || !message.conversationId) return;
    // Room broadcasts carry the SENDER's perspective — resolve isMine against
    // the logged-in user before the message enters chat state.
    const resolved = resolveMessageForViewer(message, userRef.current?.id);
    // Skip our own echoes only when the optimistic copy is already here
    // (messages sent from another device still need to appear).
    const localList = messagesRef.current[resolved.conversationId] ?? [];
    const isEcho = Boolean(
      resolved.clientNonce && localList.some((m) => m.clientNonce === resolved.clientNonce)
    );
    if (!isEcho) appendMessage(resolved);
    // Acknowledge device receipt for other people's messages → delivered tick.
    if (!resolved.isMine) ackDelivered(resolved.conversationId);
  });

  useSocketEvent<{ messageId: string; conversationId: string }>(EVENTS.MESSAGE_DELETED, (payload) => {
    updateMessage(payload.conversationId, payload.messageId, {
      deletedAt: new Date().toISOString(),
      content: null,
      attachments: [],
      reactions: []
    });
  });

  useSocketEvent<MessageDTO>(EVENTS.MESSAGE_UPDATED, (message) => {
    // Same room broadcast — re-derive isMine so an edit does not overwrite
    // local alignment with the sender's perspective.
    updateMessage(message.conversationId, message.id, resolveMessageForViewer(message, userRef.current?.id));
  });

  useSocketEvent<{
    messageId: string;
    conversationId: string;
    reactions: { emoji: string; userId: string }[];
    userId: string;
    emoji: string;
    reacted: boolean;
  }>(EVENTS.MESSAGE_REACTION, (payload) => {
    setMessages((prev) => {
      const list = prev[payload.conversationId] ?? [];
      return {
        ...prev,
        [payload.conversationId]: list.map((m) => {
          if (m.id !== payload.messageId) return m;
          const map = new Map<string, { emoji: string; count: number; userIds: string[]; reacted: boolean }>();
          for (const r of payload.reactions) {
            const entry = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [], reacted: false };
            entry.count += 1;
            entry.userIds.push(r.userId);
            if (r.userId === userRef.current?.id) entry.reacted = true;
            map.set(r.emoji, entry);
          }
          return { ...m, reactions: Array.from(map.values()) };
        })
      };
    });
  });

  useSocketEvent<{ conversationId: string; userId: string; messageId: string | null; readAt: string }>(
    EVENTS.MESSAGE_READ,
    (payload) => {
      if (payload.userId === userRef.current?.id) return;
      const othersCount = Math.max(
        1,
        (conversationsRef.current.find((c) => c.id === payload.conversationId)?.memberCount ?? 2) -
          1
      );
      setMessages((prev) => ({
        ...prev,
        [payload.conversationId]: (prev[payload.conversationId] ?? []).map((m) => {
          if (m.createdAt > payload.readAt) return m;
          const readBy = m.readBy ?? [];
          if (readBy.includes(payload.userId)) return m;
          const nextReadBy = [...readBy, payload.userId];
          // Upgrade my own ticks live: blue once every other member has read.
          let status = m.status;
          if (m.isMine && status !== 'SENDING' && status !== 'FAILED') {
            status = nextReadBy.length >= othersCount ? 'READ' : 'DELIVERED';
          }
          return { ...m, readBy: nextReadBy, status };
        })
      }));
    }
  );

  useSocketEvent<{ conversationId: string; userId: string; deliveredAt: string }>(
    EVENTS.MESSAGE_DELIVERED,
    (payload) => {
      if (payload.userId === userRef.current?.id) return;
      setMessages((prev) => ({
        ...prev,
        [payload.conversationId]: (prev[payload.conversationId] ?? []).map((m) => {
          if (!m.isMine || m.createdAt > payload.deliveredAt) return m;
          if (m.status === 'READ' || m.status === 'DELIVERED' || m.status === 'SENDING' || m.status === 'FAILED') {
            return m;
          }
          return { ...m, status: 'DELIVERED' };
        })
      }));
    }
  );

  // On reconnect, refetch previews and reconcile any open thread so nothing
  // missed while offline is lost (dedupe keeps this idempotent).
  const seenFirstConnect = useRef(false);
  useSocketEvent('connect', () => {
    void refreshConversations();
    if (!seenFirstConnect.current) {
      seenFirstConnect.current = true;
      return;
    }
    for (const [convId, loaded] of Object.entries(messagesLoadedRef.current)) {
      if (loaded) void reconcileMessages(convId);
    }
  });

  useSocketEvent<TypingPayload>(EVENTS.TYPING_START, (payload) => {
    if (payload.userId === userRef.current?.id) return;
    setTypingMap((prev) => {
      const names = prev[payload.conversationId] ?? [];
      if (names.includes(payload.displayName)) return prev;
      return { ...prev, [payload.conversationId]: [...names, payload.displayName] };
    });
  });

  useSocketEvent<TypingPayload>(EVENTS.TYPING_STOP, (payload) => {
    if (payload.userId === userRef.current?.id) return;
    setTypingMap((prev) => ({
      ...prev,
      [payload.conversationId]: (prev[payload.conversationId] ?? []).filter(
        (n) => n !== payload.displayName
      )
    }));
  });

  useSocketEvent<{
    conversationId: string;
    removed?: boolean;
    membersChanged?: boolean;
    added?: boolean;
    title?: string | null;
    description?: string | null;
    avatarUrl?: string | null;
  }>(EVENTS.CONVERSATION_UPDATED, (payload) => {
    if (!payload?.conversationId) return;

    // Removed from the group: drop it locally right away — the server has
    // already evicted our sockets from its room.
    if (payload.removed) {
      setConversations((prev) => prev.filter((c) => c.id !== payload.conversationId));
      setMessages((prev) => {
        const next = { ...prev };
        delete next[payload.conversationId];
        return next;
      });
      setTypingMap((prev) => {
        const next = { ...prev };
        delete next[payload.conversationId];
        return next;
      });
      return;
    }

    // Live-patch renamed/re-photographed groups before the list refetch lands.
    if (
      payload.title !== undefined ||
      payload.description !== undefined ||
      payload.avatarUrl !== undefined
    ) {
      patchConversation(payload.conversationId, {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.avatarUrl !== undefined ? { avatarUrl: payload.avatarUrl } : {})
      });
    }

    // Reload list to reflect member/role/title changes
    void refreshConversations();
  });

  // Ask socket to join conversation rooms when they appear
  useEffect(() => {
    if (!socket) return;
    for (const c of conversations) {
      socket.emit('conversation:join', { conversationId: c.id });
    }
  }, [socket, conversations]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );

  // Global unread — derived from the same server-reconciled per-conversation
  // counts, so it survives refresh/reconnect and updates immediately on
  // realtime messages and mark-read.
  const totalUnread = useMemo(() => sumUnread(conversations), [conversations]);

  const value = useMemo<ChatContextValue>(
    () => ({
      conversations,
      conversationsLoaded,
      conversationsError,
      activeId,
      setActive,
      activeConversation,
      messages,
      messagesLoaded,
      hasMoreOlder,
      loadingOlder,
      loadOlder,
      messagesError,
      retryMessages,
      sendMessage,
      retryMessage,
      editMessage,
      deleteMessage,
      toggleReaction,
      forwardMessage,
      markRead,
      typing,
      setTyping,
      totalUnread,
      refreshConversations,
      upsertConversation,
      patchConversation
    }),
    [
      conversations,
      conversationsLoaded,
      conversationsError,
      activeId,
      setActive,
      activeConversation,
      messages,
      messagesLoaded,
      hasMoreOlder,
      loadingOlder,
      loadOlder,
      messagesError,
      retryMessages,
      sendMessage,
      retryMessage,
      editMessage,
      deleteMessage,
      toggleReaction,
      forwardMessage,
      markRead,
      typing,
      setTyping,
      totalUnread,
      refreshConversations,
      upsertConversation,
      patchConversation
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

function sortConversations(list: ConversationDTO[]): ConversationDTO[] {
  return [...list].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    const at = a.lastMessageAt ?? a.createdAt;
    const bt = b.lastMessageAt ?? b.createdAt;
    return at > bt ? -1 : at < bt ? 1 : 0;
  });
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
