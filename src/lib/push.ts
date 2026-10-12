/**
 * Web Push delivery (Phase 3, Part 1) — REAL delivery via the `web-push`
 * library + VAPID credentials from the environment.
 *
 * Hard rules (from the remediation brief):
 *  - NEVER report "push sent" when no provider/credentials exist.
 *  - Production fails SAFE when VAPID is missing: delivery is skipped and
 *    reported as not-sent — the app keeps working, nothing fakes success.
 *  - Provider errors are handled; permanently invalid/expired endpoints
 *    (HTTP 404/410) are removed from storage safely.
 *  - Logs never contain push tokens, endpoints, or notification content.
 *
 * Tests inject a mock transport with `setPushTransportForTests` (same
 * pattern as the mailer) so provider invocation is verifiable without a
 * real push service.
 */
import webpush from 'web-push';
import { db } from '@/lib/db';
import { pushAgentForEndpoint } from '@/lib/push-loopback-tls';
import { badgeCount, notificationAllowed, type NotificationGateSettings } from '@/lib/notifications';

export interface PushPayload {
  title: string;
  body?: string;
  icon?: string;
  data?: Record<string, unknown>;
  tag?: string;
  /** OS notification sound. True when the user turned sounds off. */
  silent?: boolean;
  /** Unread count for app-icon badges. Never message content. */
  badge?: number;
}

export interface PushSubscriptionLike {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushSendResult = {
  sent: boolean;
  /** Endpoint is permanently invalid (404/410) — caller should remove it. */
  gone?: boolean;
  reason?: string;
};

/** Which notification preference gates a push. */
export type PushKind = 'MESSAGE' | 'GROUP_MESSAGE' | 'REACTION' | 'CALL' | 'STATUS';

export interface PushDispatchInput {
  userId: string;
  kind: PushKind;
  title: string;
  body?: string;
  /** Deep-link payload for the service worker (internal ids only). */
  data?: Record<string, unknown>;
  /** Coalescing tag — one visible notification per conversation/device. */
  tag?: string;
  /** Owning notification row, so a background tap can mark that row read. */
  notificationId?: string;
}

export interface PushDispatchSummary {
  /** Endpoints where delivery was confirmed (HTTP 201 from the push service). */
  delivered: number;
  /** Endpoint failures (network/5xx) — subscription kept for retry later. */
  failed: number;
  /** Permanently invalid endpoints that were deleted. */
  removed: number;
  /** Set when no send was attempted (not-configured / disabled / no subs). */
  skipped: 'not-configured' | 'disabled' | 'no-subscriptions' | null;
}

// ── Transport injection (tests) ──────────────────────────────────────────

export type PushTransport = (
  subscription: PushSubscriptionLike,
  payloadJson: string
) => Promise<{ statusCode: number }>;

let testTransport: PushTransport | null = null;

export function setPushTransportForTests(transport: PushTransport | null) {
  testTransport = transport;
}

// ── VAPID configuration ──────────────────────────────────────────────────

/**
 * Lossless normalization of VAPID env values (the production incident:
 * credential strings pasted into Railway with wrapping quotes, trailing
 * newlines from copy/paste, base64 `=` padding, or standard-base64 `+/`
 * characters — web-push's validators reject all of these by THROWING, which
 * we used to swallow into a misleading "not configured"). None of these
 * transforms can change the decoded key material:
 *  - surrounding whitespace/CR/LF is stripped;
 *  - ONE pair of wrapping quotes ("" or '') is stripped;
 *  - standard base64 `+`/`/` map to base64url `-_`;
 *  - trailing `=` padding is stripped (decoders accept unpadded).
 * Anything else (truncation, swapped roles, wrong length) stays invalid —
 * and is reported with a precise, secret-free reason.
 */
function normalizeVapidValue(raw: string): string {
  let v = raw.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function normalizeVapidKey(raw: string): string {
  return normalizeVapidValue(raw).replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type VapidConfigStatus =
  | { ok: true; subject: string; publicKey: string }
  | {
      ok: false;
      /** Safe to show/log — never contains credential values. */
      reason: 'missing' | 'invalid-subject' | 'invalid-public-key' | 'invalid-private-key';
      detail: string;
    };

/**
 * Validate the VAPID env vars against web-push's rules, BEFORE calling it.
 * The result NEVER carries the private key (it is read again internally when
 * configuring the web-push library) — the status is safe to expose.
 */
export function diagnoseVapid(): VapidConfigStatus {
  const subject = normalizeVapidValue(process.env.VAPID_SUBJECT ?? '');
  const publicKey = normalizeVapidKey(process.env.VAPID_PUBLIC_KEY ?? '');
  const privateKey = normalizeVapidKey(process.env.VAPID_PRIVATE_KEY ?? '');

  if (!subject || !publicKey || !privateKey) {
    return {
      ok: false,
      reason: 'missing',
      detail: 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT to enable push.'
    };
  }

  // Same rules as web-push/src/vapid-helper.js (checked first so the operator
  // gets a precise reason instead of a swallowed exception).
  let protocol: string | null = null;
  try {
    protocol = new URL(subject).protocol;
  } catch {
    protocol = null;
  }
  if (!protocol || !['https:', 'mailto:'].includes(protocol)) {
    return {
      ok: false,
      reason: 'invalid-subject',
      detail: 'VAPID_SUBJECT must be an https: URL or mailto: address.'
    };
  }

  const isUrlSafeBase64 = (v: string) => /^[A-Za-z0-9_-]+$/.test(v);
  const decodedLen = (v: string) => {
    try {
      return Buffer.from(v, 'base64url').length;
    } catch {
      return -1;
    }
  };

  if (!isUrlSafeBase64(publicKey) || decodedLen(publicKey) !== 65) {
    return {
      ok: false,
      reason: 'invalid-public-key',
      detail: 'VAPID_PUBLIC_KEY must be unpadded URL-safe base64 decoding to 65 bytes (npx web-push generate-vapid-keys).'
    };
  }
  if (!isUrlSafeBase64(privateKey) || decodedLen(privateKey) !== 32) {
    return {
      ok: false,
      reason: 'invalid-private-key',
      detail: 'VAPID_PRIVATE_KEY must be unpadded URL-safe base64 decoding to 32 bytes (npx web-push generate-vapid-keys).'
    };
  }

  return { ok: true, subject, publicKey };
}

let vapidState: { fingerprint: string; valid: boolean; status?: VapidConfigStatus } | null = null;

/** True only when complete VAPID credentials are present AND valid. */
export function isPushConfigured(): boolean {
  return getVapidStatus().ok;
}

/**
 * Full configuration status (safe to expose): `configured` plus a precise
 * `configuredReason` when disabled. NEVER contains credential values.
 */
export function getVapidStatus(): VapidConfigStatus {
  const status = diagnoseVapid();
  const fingerprint = JSON.stringify([
    status.ok,
    status.ok ? status.subject : status.reason,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  ]);
  if (!vapidState || vapidState.fingerprint !== fingerprint) {
    let finalStatus: VapidConfigStatus = status;
    if (status.ok) {
      try {
        const privateKey = normalizeVapidKey(process.env.VAPID_PRIVATE_KEY ?? '');
        webpush.setVapidDetails(status.subject, status.publicKey, privateKey);
      } catch {
        // Malformed keys must never crash the app — push is simply unavailable.
        finalStatus = {
          ok: false,
          reason: 'invalid-public-key',
          detail: 'VAPID credentials were rejected by the web-push library.'
        };
      }
    }
    vapidState = { fingerprint, valid: finalStatus.ok, status: finalStatus };
    if (!finalStatus.ok) {
      // Logs carry the failing RULE only — never credential values.
      warnOnce(`push disabled (${finalStatus.reason}): ${finalStatus.detail}`);
    }
  }
  return vapidState.status ?? diagnoseVapid();
}

/** Public VAPID key for client-side subscription (never the private key). */
export function getPublicVapidKey(): string | null {
  const fromNext = normalizeVapidKey(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '');
  if (fromNext) return fromNext;
  const fromServer = normalizeVapidKey(process.env.VAPID_PUBLIC_KEY ?? '');
  return fromServer || null;
}

let warned = false;
function warnOnce(message: string) {
  if (warned) return;
  warned = true;
  console.warn(`[push] ${message}`);
}

const SEND_TIMEOUT_MS = 5000;

/**
 * Deliver one payload to one subscription. Honest result — never claims
 * success without a provider response. 404/410 from the push service marks
 * the endpoint `gone` (caller removes it).
 */
export async function sendWebPush(
  subscription: PushSubscriptionLike,
  payload: PushPayload
): Promise<PushSendResult> {
  if (testTransport) {
    // Test transport path still honors the "no credentials → no send" rule
    // only for the real provider; tests opt in explicitly.
    try {
      const res = await testTransport(subscription, JSON.stringify(payload));
      if (res.statusCode === 404 || res.statusCode === 410) {
        return { sent: false, gone: true, reason: `endpoint gone (${res.statusCode})` };
      }
      if (res.statusCode >= 200 && res.statusCode < 300) return { sent: true };
      return { sent: false, reason: `provider returned ${res.statusCode}` };
    } catch (err) {
      return { sent: false, reason: describeError(err) };
    }
  }

  if (!isPushConfigured()) {
    return { sent: false, reason: 'VAPID keys not configured' };
  }

  try {
    // Loopback e2e endpoints use a pinned-cert agent. Real push services
    // (non-loopback) keep Node's default TLS verification — never a global
    // NODE_TLS_REJECT_UNAUTHORIZED override.
    const agent = pushAgentForEndpoint(subscription.endpoint);
    const res = await Promise.race([
      webpush.sendNotification(subscription, JSON.stringify(payload), {
        timeout: SEND_TIMEOUT_MS,
        ...(agent ? { agent } : {})
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('push send timed out')), SEND_TIMEOUT_MS)
      )
    ]);
    if (res.statusCode === 404 || res.statusCode === 410) {
      return { sent: false, gone: true, reason: `endpoint gone (${res.statusCode})` };
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return { sent: true };
    return { sent: false, reason: `provider returned ${res.statusCode}` };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      return { sent: false, gone: true, reason: `endpoint gone (${status})` };
    }
    return { sent: false, reason: describeError(err) };
  }
}

function describeError(err: unknown): string {
  // Message only — stack/objects can carry URLs/tokens into logs.
  const msg = err instanceof Error ? err.message : 'unknown push error';
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
  const combined = code && !msg.includes(code) ? `${code}: ${msg}` : msg;
  return combined.slice(0, 120);
}

function safePushReason(reason: string): string {
  return reason.replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').slice(0, 80);
}

// ── Notification-preference gate ─────────────────────────────────────────

function preferenceAllows(kind: PushKind, settings: NotificationGateSettings | null): boolean {
  return notificationAllowed({ channel: kind, settings });
}

// ── Fan-out dispatch ─────────────────────────────────────────────────────

/**
 * Fan a notification out to every push subscription of one user.
 *
 * - Honors the user's notification preferences (notifMessages/Groups/Calls).
 * - One payload per subscription (multi-device); the `tag` coalesces visible
 *   notifications so one conversation never stacks duplicates on a device.
 * - Permanently invalid endpoints are deleted (never another user's rows).
 * - Returns an honest summary; `skipped` explains why nothing was sent.
 */
export async function dispatchPush(input: PushDispatchInput): Promise<PushDispatchSummary> {
  const summary: PushDispatchSummary = { delivered: 0, failed: 0, removed: 0, skipped: null };

  if (!testTransport && !isPushConfigured()) {
    summary.skipped = 'not-configured';
    return summary;
  }

  const [subs, user] = await Promise.all([
    db.pushSubscription.findMany({ where: { userId: input.userId } }),
    db.user.findUnique({
      where: { id: input.userId },
      select: {
        settings: {
          select: {
            notifEnabled: true,
            notifMessages: true,
            notifGroups: true,
            notifCalls: true,
            notifStatus: true,
            notifSounds: true
          }
        }
      }
    })
  ]);

  if (!preferenceAllows(input.kind, user?.settings ?? null)) {
    summary.skipped = 'disabled';
    return summary;
  }
  if (subs.length === 0) {
    summary.skipped = 'no-subscriptions';
    return summary;
  }

  let badge: number | undefined;
  try {
    badge = badgeCount(await db.notification.count({ where: { userId: input.userId, readAt: null } }));
  } catch {
    badge = undefined;
  }

  const payload: PushPayload = {
    title: input.title,
    body: input.body,
    data: {
      ...(input.data ?? {}),
      ...(input.notificationId ? { notificationId: input.notificationId } : {}),
      ...(badge !== undefined ? { badge } : {})
    },
    tag: input.tag,
    silent: user?.settings?.notifSounds === false,
    badge
  };

  const results = await Promise.allSettled(
    subs.map((sub) =>
      sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
    )
  );

  const doomed: string[] = [];
  const failReasons: string[] = [];
  results.forEach((res, i) => {
    const sub = subs[i]!;
    if (res.status === 'fulfilled') {
      if (res.value.sent) summary.delivered += 1;
      else if (res.value.gone) doomed.push(sub.id);
      else {
        summary.failed += 1;
        if (res.value.reason) failReasons.push(safePushReason(res.value.reason));
      }
    } else {
      summary.failed += 1;
      failReasons.push(safePushReason(describeError(res.reason)));
    }
  });

  if (doomed.length > 0) {
    // Own rows only (scoped by id) — safe even under concurrent dispatches.
    await db.pushSubscription.deleteMany({ where: { id: { in: doomed }, userId: input.userId } });
    summary.removed = doomed.length;
  }

  // Counts and short error codes only — never endpoints, tokens, or content.
  const reasonNote = failReasons.length > 0 ? ` reasons=${failReasons.slice(0, 4).join(',')}` : '';
  console.info(
    `[push] delivered=${summary.delivered} failed=${summary.failed} removed=${summary.removed}${reasonNote}`
  );
  return summary;
}
