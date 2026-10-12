/**
 * Browser-side Web Push helpers (Phase 3, Part 2).
 *
 * IMPORTANT: `Notification.requestPermission()` is ONLY reachable through
 * `enablePush()`, which the settings UI calls from an intentional user action
 * (the "Enable" button) — the app never auto-prompts.
 */

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export type PushPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export function getPushPermission(): PushPermissionState {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission as PushPermissionState;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/** Current push subscription (registering the worker first if needed). */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  const reg = await registerPushServiceWorker();
  return reg.pushManager.getSubscription();
}

/**
 * Ask for permission + subscribe. Call ONLY from a user gesture.
 * Throws with a user-safe message when permission is denied.
 */
export async function enablePush(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.'
        : 'Notification permission was not granted.'
    );
  }
  const reg = await registerPushServiceWorker();
  const existing = await reg.pushManager.getSubscription();
  if (existing && applicationServerKeyMatches(existing, publicKey)) return existing;
  if (existing) await existing.unsubscribe().catch(() => {});
  return subscribeWithKey(reg, publicKey);
}

function applicationServerKeyMatches(existing: PushSubscription, publicKey: string): boolean {
  const raw = existing.options?.applicationServerKey;
  if (!raw) return true;
  const have = new Uint8Array(raw);
  const want = urlBase64ToUint8Array(publicKey);
  if (have.length !== want.length) return false;
  for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
  return true;
}

function subscribeWithKey(reg: ServiceWorkerRegistration, publicKey: string) {
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
}

/**
 * Refresh an already-granted subscription when the server public key rotated.
 * Never prompts. Returns null when there is nothing to refresh.
 */
export async function refreshPushSubscription(publicKey: string): Promise<PushSubscription | null> {
  if (!isPushSupported() || Notification.permission !== 'granted') return null;
  const reg = await registerPushServiceWorker();
  const existing = await reg.pushManager.getSubscription();
  if (!existing) return null;
  if (applicationServerKeyMatches(existing, publicKey)) return existing;
  await existing.unsubscribe().catch(() => {});
  return subscribeWithKey(reg, publicKey);
}

/** Unsubscribe in the browser (server-side row removal is done by the caller). */
export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
}

export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export function subscriptionToBody(sub: PushSubscription): PushSubscriptionBody | null {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 256) : undefined
  };
}
