/**
 * Phase 4E — server-authoritative WebRTC ICE configuration.
 *
 * One place parses STUN/TURN settings from environment variables and hands
 * the browser ONLY the ICE-server list it needs to create an RTCPeerConnection
 * (via the authenticated GET /api/calls/ice endpoint). Credentials are never
 * logged, never rendered into HTML, and never referenced from NEXT_PUBLIC_*
 * variables (which would be inlined into the public client bundle).
 *
 * Provider-agnostic: any TURN service that accepts username + credential
 * authentication works (Cloudflare Calls, Metered, Twilio NTS, coturn, …).
 *
 * Environment variables (all optional — the app runs fine without TURN):
 *   STUN_URLS       comma-separated stun:/stuns: URLs
 *                   (default: Google's public STUN pair)
 *   TURN_URLS       comma-separated turn:/turns: URLs; per-URL ?transport=udp|tcp
 *                   is honored, turns: implies TLS
 *   TURN_USERNAME   TURN account username
 *   TURN_CREDENTIAL TURN account credential
 *
 * TURN is only emitted when TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL are
 * all present and every URL parses; otherwise the call falls back to
 * STUN/direct ICE exactly as before.
 */

export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigSummary {
  stunUrlCount: number;
  turnUrlCount: number;
  /** Protocols seen in the parsed TURN URLs: 'udp' | 'tcp' | 'tls'. */
  turnProtocols: string[];
  turnAuthConfigured: boolean;
}

export interface IceConfigResult {
  iceServers: IceServerEntry[];
  summary: IceConfigSummary;
  /** Safe-to-log configuration problems. Never contain credentials. */
  warnings: string[];
}

export type EnvLike = Record<string, string | undefined>;

const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
const MAX_URLS_PER_KIND = 16;

/** Split a comma/whitespace-separated URL list; drops empties. */
function splitUrls(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

function isStunUrl(url: string): boolean {
  return /^stuns?:[^\s/]+$/i.test(url);
}

/** Parse a turn:/turns: URL. Returns the transport protocol or null when invalid. */
function turnProtocol(url: string): 'udp' | 'tcp' | 'tls' | null {
  const m = /^(turns?):([^\s/?]+)(?:\?transport=(udp|tcp))?$/i.exec(url);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  const explicit = m[3]?.toLowerCase();
  if (scheme === 'turns') return 'tls'; // turns: is always TLS
  if (explicit === 'tcp') return 'tcp';
  return 'udp'; // turn: default, or explicit ?transport=udp
}

/**
 * Build the ICE configuration from an environment snapshot. Pure — unit
 * tested exhaustively. Invalid entries are skipped with a warning; the
 * process never throws on bad configuration.
 */
export function parseIceConfig(env: EnvLike): IceConfigResult {
  const warnings: string[] = [];

  // ── STUN ────────────────────────────────────────────────────────────────
  const stunRaw = env.STUN_URLS?.trim();
  const stunUrls = (stunRaw ? splitUrls(stunRaw) : DEFAULT_STUN_URLS).filter((u) => {
    if (isStunUrl(u)) return true;
    warnings.push(`Ignoring STUN URL with an unsupported scheme: ${u.split(':')[0] || '(empty)'}:…`);
    return false;
  });

  // ── TURN ────────────────────────────────────────────────────────────────
  const turnRaw = env.TURN_URLS?.trim();
  const turnUsername = env.TURN_USERNAME?.trim() || undefined;
  const turnCredential = env.TURN_CREDENTIAL?.trim() || undefined;
  const turnProtocols = new Set<string>();
  const turnUrls: string[] = [];

  if (turnRaw) {
    const candidates = splitUrls(turnRaw);
    if (candidates.length > MAX_URLS_PER_KIND) {
      warnings.push(`TURN_URLS lists ${candidates.length} URLs; only the first ${MAX_URLS_PER_KIND} are used.`);
    }
    for (const url of candidates.slice(0, MAX_URLS_PER_KIND)) {
      const proto = turnProtocol(url);
      if (!proto) {
        // Print the scheme only — never echo anything that might embed a secret.
        warnings.push(`Ignoring TURN URL with an unsupported format: ${url.split(':')[0] || '(empty)'}:…`);
        continue;
      }
      turnUrls.push(url);
      turnProtocols.add(proto);
    }
    if (turnUrls.length > 0 && (!turnUsername || !turnCredential)) {
      warnings.push(
        'TURN_URLS is set but TURN_USERNAME/TURN_CREDENTIAL are missing or empty — ignoring TURN (calls use STUN/direct ICE only).'
      );
      turnUrls.length = 0;
      turnProtocols.clear();
    }
  } else if (turnUsername || turnCredential) {
    warnings.push('TURN_USERNAME/TURN_CREDENTIAL are set but TURN_URLS is empty — ignoring TURN credentials.');
  }

  const turnAuthConfigured = turnUrls.length > 0 && !!turnUsername && !!turnCredential;

  // ── Assemble (STUN first: direct/srflx candidates before relay) ─────────
  const iceServers: IceServerEntry[] = [];
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });
  if (turnAuthConfigured) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential
    });
  }

  return {
    iceServers,
    summary: {
      stunUrlCount: stunUrls.length,
      turnUrlCount: turnAuthConfigured ? turnUrls.length : 0,
      turnProtocols: [...turnProtocols].sort(),
      turnAuthConfigured
    },
    warnings
  };
}

let cache: IceConfigResult | null = null;

/** Memoized parse of the real process environment (server-side only). */
export function getIceConfig(): IceConfigResult {
  if (!cache) cache = parseIceConfig(process.env as EnvLike);
  return cache;
}

/** Test hook — drop the memoized environment parse. */
export function resetIceConfigCache(): void {
  cache = null;
}

/**
 * A one-line, credential-free description of the configuration for logs.
 * Provably contains no username/credential values (unit tested).
 */
export function describeIceConfigForLog(result: IceConfigResult): string {
  const { summary } = result;
  const proto = summary.turnProtocols.length > 0 ? ` (${summary.turnProtocols.join(',')})` : '';
  const auth = summary.turnAuthConfigured ? 'turn auth configured' : 'no turn';
  return `ICE config: ${summary.stunUrlCount} STUN url(s), ${summary.turnUrlCount} TURN url(s)${proto}, ${auth}`;
}

/**
 * Replace every occurrence of the given secrets in a string with a redaction
 * marker. Used for any log line that might touch configuration material.
 */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue; // nothing meaningful to mask
    out = out.split(secret).join('[redacted]');
  }
  return out;
}
