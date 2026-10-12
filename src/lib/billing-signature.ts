import { createHmac, timingSafeEqual } from 'crypto';

function safeEqualHex(expected: string, given: string): boolean {
  if (!/^[0-9a-f]+$/i.test(given) || expected.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
}

/** HMAC-SHA256 of the raw body. Used by the test provider webhook. */
export function signTestWebhook(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

export function verifyTestWebhook(raw: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  return safeEqualHex(signTestWebhook(raw, secret), signature.trim());
}

/**
 * Stripe-Signature: t=unix,v1=hex. Rejects missing, stale (>5 min), and
 * mismatched signatures. Does not log the secret or the body.
 */
export function verifyStripeSignature(
  raw: string,
  header: string | null,
  secret: string,
  now = Date.now()
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  const t = Number(timestamp);
  if (!Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return signatures.some((signature) => safeEqualHex(expected, signature));
}
