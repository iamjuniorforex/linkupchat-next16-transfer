'use client';

/**
 * Settings UI for Web Push (Phase 3, Part 2).
 *
 * - Shows current permission + subscription state.
 * - Requests notification permission ONLY when the user clicks Enable.
 * - Supports unsubscribe/revoke (browser + server row).
 * - Graceful messaging when the browser lacks Push/ServiceWorker APIs or
 *   the server has no VAPID credentials configured.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, MonitorSmartphone, RefreshCw } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import {
  disablePush,
  enablePush,
  getPushPermission,
  getPushSubscription,
  isPushSupported,
  subscriptionToBody,
  type PushPermissionState
} from '@/lib/push-client';

type ServerState = {
  configured: boolean;
  configuredReason?: 'ok' | 'missing' | 'invalid-subject' | 'invalid-public-key' | 'invalid-private-key';
  configuredDetail?: string | null;
  publicKey: string | null;
  subscriptions: { id: string; endpoint: string; userAgent: string | null; createdAt: string }[];
} | null;

export function PushNotificationsCard() {
  const toast = useToast();
  const [server, setServer] = useState<ServerState>(null);
  const [loaded, setLoaded] = useState(false);
  const [permission, setPermission] = useState<PushPermissionState>('unsupported');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const supported = isPushSupported();

  const refresh = useCallback(async () => {
    if (!supported) {
      setPermission('unsupported');
      return;
    }
    setPermission(getPushPermission());
    try {
      const res = await fetch('/api/push/subscribe');
      const json = await res.json();
      if (res.ok && json.ok) {
        setServer(json.data);
        const sub = await getPushSubscription();
        setSubscribed(Boolean(sub));
      }
    } catch {
      /* keep last known state */
    } finally {
      // First fetch has settled: render the authoritative state from here on.
      setLoaded(true);
    }
  }, [supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    if (!server?.configured || !server.publicKey) return;
    setBusy(true);
    try {
      const sub = await enablePush(server.publicKey);
      const body = subscriptionToBody(sub);
      if (!body) throw new Error('Could not read the push subscription.');
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error?.message ?? 'Could not save the subscription.');
      }
      toast.success('Push notifications enabled', 'This device will now receive notifications.');
      await refresh();
    } catch (err) {
      toast.error('Could not enable push', err instanceof Error ? err.message : undefined);
      setPermission(getPushPermission());
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const sub = await getPushSubscription();
      if (sub) {
        // Remove MY server row first (idempotent), then unsubscribe locally.
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint })
        }).catch(() => {});
        await disablePush();
      }
      toast.success('Push notifications disabled', 'This device will no longer receive push notifications.');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border p-4" data-testid="push-notifications-card">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Bell className="h-4 w-4 text-brand-500" aria-hidden /> Browser push
      </p>

      {!supported ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          This browser does not support Web Push notifications (no Service Worker or Push API).
          In-app notifications keep working normally.
        </p>
      ) : !loaded ? (
        // Never flash the Enable UI before the server state is known — on a
        // server without usable VAPID credentials the flip looked like the
        // Push Notifications section "disappearing" a second after opening.
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Checking push support…
        </p>
      ) : server && !server.configured ? (
        server.configuredReason && server.configuredReason !== 'missing' ? (
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Push notifications are configured on this server but the VAPID credentials were
            rejected
            {server.configuredDetail ? ` (${server.configuredDetail})` : ''}. In-app
            notifications keep working normally.
          </p>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Push notifications are not available on this server yet (VAPID credentials are not
            configured). In-app notifications keep working normally.
          </p>
        )
      ) : (
        <>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Get notified about new messages even when LINKUPCHAT is closed. Permission is only
            requested when you turn this on.
          </p>

          <div className="mt-3 flex items-center gap-2 text-xs text-muted">
            <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden />
            <span>
              {subscribed
                ? `Enabled on this device · ${server?.subscriptions?.length ?? 1} device(s) registered`
                : permission === 'denied'
                  ? 'Notifications are blocked for this site in your browser settings.'
                  : 'Not enabled on this device.'}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {subscribed ? (
              <button
                type="button"
                onClick={disable}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-50 disabled:opacity-50"
              >
                <BellOff className="h-3.5 w-3.5" aria-hidden />
                Disable on this device
              </button>
            ) : (
              <button
                type="button"
                data-testid="enable-push-notifications"
                onClick={enable}
                disabled={busy || permission === 'denied' || !server?.configured}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                <Bell className="h-3.5 w-3.5" aria-hidden />
                Enable on this device
              </button>
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:bg-surface-50 disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh
            </button>
          </div>

          {permission === 'denied' && (
            <p className="mt-2 text-xs text-amber-600">
              To re-enable, allow notifications for this site in your browser settings and refresh.
            </p>
          )}
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Background delivery depends on the browser and operating system. iOS only delivers Web
            Push to a site installed on the Home Screen, and a closed browser tab may not receive
            alerts. LINKUPCHAT does not claim delivery when the OS blocks it. In-app notifications
            still work while the app is open.
          </p>
        </>
      )}
    </div>
  );
}
