/**
 * Loopback Web Push TLS for the local fake push service used by
 * `tests/push.e2e.ts`.
 *
 * That service presents one pinned self-signed certificate whose CN is not
 * `localhost`. Node's default HTTPS agent rejects it (`self-signed
 * certificate` / hostname mismatch), so every delivery fails before HTTP
 * status is visible — 410 cleanup never runs, and a later unsubscribe leaves
 * the endpoint that should have been removed.
 *
 * Disabling TLS globally (`NODE_TLS_REJECT_UNAUTHORIZED=0`) would also trust
 * arbitrary certificates for real push services. This agent is used ONLY for
 * loopback endpoints, trusts the public CA store plus this one pinned test
 * certificate, and skips the hostname check only when the peer certificate
 * fingerprint matches the pin. Every other host keeps Node's default agent.
 */
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';

/** Public test certificate. The matching private key lives only in the e2e. */
export const PUSH_E2E_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUOc5MICVVjn+dGbe5sQvuJRp08C8wDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNcHVzaC1lMmUtdGVzdDAeFw0yNjEwMDExMjQyNDdaFw0z
NjA5MjgxMjQyNDdaMBgxFjAUBgNVBAMMDXB1c2gtZTJlLXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQC9FgYLT+OkbfvJKMCgbW+515zTj8NwhIuT
Xpt4O3bbmDJlRkBPBNVbG8gOodZqeokjqENg8F9tI3s8TZ0JN1LY57haKJiyynXN
8Aq9k2KlTwj1qQTAo9OkZJaKiMKOvPM64WzfTM8zve0540zL8GQfRL4OBZiRl/Ir
D9ZorBMBEksL0gzEWWt7MdXbanA7hJ81Af2iEp+0jZn0AbXw8vZngKH0R2f8+R2H
HKJVQyCewivtgA+rwVibFWkjvK666u7Lx1GuZFi2/OhfsmbDp1eeKOnHMciZ7Bd/
jSY1QvlCwa79MKR8zF83yN1Kv1R7cAseHl+WDOQwGwSlaoLr3ek5AgMBAAGjUzBR
MB0GA1UdDgQWBBSr4Xx2FLJVZipQtlQX/B1KYFfRPzAfBgNVHSMEGDAWgBSr4Xx2
FLJVZipQtlQX/B1KYFfRPzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQBWRbhpUweFbnHiiC/ghbmU4eAbsU5O6uIdQKVsuO63xJQSlTg1EF7O3gK0
WFP7mlQcUIhXXoJT7B+0CXZJLWfl7ZENi7rAUh/V4qvsnomaDj3KrLHpqNMPBxPk
HSAdQZKJMSBmGvbVHYPwy6FTxGjAWZqRk9U6866tRaGOEXB4hl5w/vZnqv4G14CC
BChbjeOOrrsV8MjXrcbUKRKRcz/MA24xCVcs7PZTO4h5BBPjMoDvWOQ1qGrCkVp+
PvS8AdsviBGfHtaIKkvSXnUPDp+IkjLS3gcGFHXeePunoFSy8U7Q9TCrzKKG9YEo
1Hs6oRI984wE7p4jxo+OCMVfWP0n
-----END CERTIFICATE-----`;

function certDer(pem: string): Buffer {
  const b64 = pem.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

const PINNED_FINGERPRINT = crypto.createHash('sha256').update(certDer(PUSH_E2E_TEST_CERT)).digest('hex');

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** True only for https URLs whose host is the local machine. */
export function isLoopbackPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function checkServerIdentity(host: string, cert: tls.PeerCertificate): Error | undefined {
  const presented = cert.fingerprint256?.replace(/:/g, '').toLowerCase();
  if (presented && presented === PINNED_FINGERPRINT) return undefined;
  return tls.checkServerIdentity(host, cert);
}

let loopbackAgent: https.Agent | null = null;

/**
 * Agent for loopback push endpoints, or undefined so the caller keeps
 * Node's default agent (real push services, non-https, non-loopback).
 */
export function pushAgentForEndpoint(endpoint: string): https.Agent | undefined {
  if (!isLoopbackPushEndpoint(endpoint)) return undefined;
  if (!loopbackAgent) {
    loopbackAgent = new https.Agent({
      keepAlive: false,
      ca: [...tls.rootCertificates, PUSH_E2E_TEST_CERT],
      checkServerIdentity
    });
  }
  return loopbackAgent;
}
