'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { EVENTS, type PresencePayload } from '@shared/events';
import { useAuth } from './AuthProvider';

interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
  presence: Record<string, { online: boolean; lastSeenAt: string | null }>;
  isOnline: (userId: string) => boolean;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<Record<string, { online: boolean; lastSeenAt: string | null }>>({});

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      return;
    }

    // Same-origin socket — works behind the same host/port as the web app.
    const socket = io({
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000
    });
    socketRef.current = socket;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onPresence = (payload: PresencePayload) => {
      setPresence((prev) => ({
        ...prev,
        [payload.userId]: { online: payload.online, lastSeenAt: payload.lastSeenAt }
      }));
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on(EVENTS.PRESENCE_UPDATE, onPresence);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(EVENTS.PRESENCE_UPDATE, onPresence);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user?.id]);

  const value = useMemo<SocketContextValue>(
    () => ({
      socket: socketRef.current,
      connected,
      presence,
      isOnline: (userId: string) => presence[userId]?.online ?? false
    }),
    [connected, presence]
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used within SocketProvider');
  return ctx;
}

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocketEvent<T = unknown>(event: string, handler: (payload: T) => void) {
  const { socket } = useSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!socket) return;
    const fn = (payload: T) => handlerRef.current(payload);
    socket.on(event, fn);
    return () => {
      socket.off(event, fn);
    };
  }, [socket, event]);
}
