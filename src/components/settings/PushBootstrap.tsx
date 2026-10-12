'use client';

/**
 * Passive Web Push bootstrap (Phase 3, Part 2).
 *
 * Runs inside the authed app shell. NEVER prompts for permission — it only:
 *  - registers the service worker when notifications are already granted
 *    (so push keeps working across visits), and
 *  - re-syncs an existing browser subscription to the server (covers key
 *    rotation and multi-device registration).
 * Users without an existing subscription are left completely alone.
 */
import { useEffect } from 'react';
import {
  getPushSubscription,
  isPushSupported,
  refreshPushSubscription,
  registerPushServiceWorker,
  subscriptionToBody
} from '@/lib/push-client';

export function PushBootstrap() {
  useEffect(() => {
    if (!isPushSupported()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    let cancelled = false;

    (async () => {
      try {
        await registerPushServiceWorker();
        const status = await fetch('/api/push/subscribe').then((r) => r.json()).catch(() => null);
        const publicKey = status?.data?.publicKey;
        const refreshed = typeof publicKey === 'string' ? await refreshPushSubscription(publicKey) : null;
        const sub = refreshed ?? (await getPushSubscription());
        if (!sub || cancelled) return;
        const body = subscriptionToBody(sub);
        if (!body) return;
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch {
        // Passive sync must never disturb the app.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
