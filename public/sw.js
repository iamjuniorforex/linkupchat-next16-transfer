/**
 * LINKUPCHAT service worker — Web Push (Phase 3, Part 2).
 *
 * - `push`: displays the server-sent notification payload as-is. The server
 *   has already applied privacy rules (notifPreview etc.), so titles/bodies
 *   here never re-derive content from anywhere else.
 * - `notificationclick`: deep-links ONLY to internal /app/ routes built from
 *   validated ids (data.url is checked again here — no external navigation,
 *   no private message content in URLs). An open client gets a postMessage
 *   so the SPA can route without a full reload. Background delivery is
 *   best-effort: iOS and desktop OS policies can drop a push, and this
 *   worker never claims otherwise.
 * - `fetch`: navigation requests stay network-first. If the network fails,
 *   a short offline page is returned. API, socket, and push traffic are not
 *   intercepted and nothing private is cached.
 */

function applyBadge(count) {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== 'function') return Promise.resolve();
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) {
    return typeof nav.clearAppBadge === 'function' ? nav.clearAppBadge().catch(() => {}) : Promise.resolve();
  }
  return nav.setAppBadge(Math.min(99, Math.floor(n))).catch(() => {});
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = (typeof payload.title === 'string' && payload.title) || 'LINKUPCHAT';
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    renotify: false,
    silent: payload.silent === true,
    data,
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'mark-read', title: 'Mark read' }
    ]
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      applyBadge(payload.badge != null ? payload.badge : data.badge)
    ])
  );
});

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · LINKUPCHAT</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0C0E1A;color:#fff;padding:24px;text-align:center"><main><h1 style="font-size:1.25rem;margin:0 0 8px">You're offline</h1><p style="margin:0;opacity:.8;line-height:1.5">LINKUPCHAT needs a connection for new messages and calls. Reopen the app when you're back online.</p></main></body></html>`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return;
  event.respondWith(
    fetch(req).catch(
      () =>
        new Response(OFFLINE_HTML, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        })
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  if (event.action === 'mark-read') {
    const id = data.notificationId;
    event.waitUntil(
      (async () => {
        if (typeof id !== 'string' || !id) return;
        const res = await fetch('/api/notifications', {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id] })
        });
        const json = await res.json().catch(() => null);
        const unread = json && json.data ? json.data.unread : undefined;
        if (typeof unread === 'number') await applyBadge(unread);
      })()
    );
    return;
  }
  // Internal routes only — never trust a payload to steer navigation outside.
  const url =
    typeof data.url === 'string' && /^\/app\/[A-Za-z0-9_\-/?=.]+$/.test(data.url)
      ? data.url
      : '/app';

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          client.postMessage({ type: 'linkup:navigate', url });
          await client.focus();
          return;
        }
      }
      if (self.clients && self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })()
  );
});
