'use client';

import { useEffect, useState } from 'react';
import { useSocket } from '@/context/SocketProvider';

/**
 * Offline and reconnecting state. Shown only after a real drop — the first
 * socket connect must not flash "Reconnecting". Does not queue or retry
 * messages itself; sending still uses the existing chat path.
 */
export function ConnectionBanner() {
  const { connected } = useSocket();
  const [online, setOnline] = useState(true);
  const [sawConnect, setSawConnect] = useState(false);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  useEffect(() => {
    if (connected) setSawConnect(true);
  }, [connected]);

  const offline = !online;
  const reconnecting = online && sawConnect && !connected;
  if (!offline && !reconnecting) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="status-banner shrink-0 px-4 py-2 text-center text-xs font-semibold"
    >
      {offline
        ? "You're offline. Open chats stay on this device; new messages send when you reconnect."
        : 'Reconnecting…'}
    </div>
  );
}
