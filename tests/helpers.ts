/**
 * Shared e2e infrastructure: HTTP login/session helpers, cookie-authenticated
 * Socket.IO connections, and a small check/report harness. Used by the
 * message-alignment and unread e2e suites.
 */
import { io, type Socket } from 'socket.io-client';

export const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3300';

export interface Session {
  id: string;
  username: string;
  cookie: string;
  headers: Record<string, string>;
}

export async function login(username: string, password = 'linkup123'): Promise<Session> {
  // Production rate-limits login (15/min/IP) — when suites run back-to-back
  // we wait out the window instead of failing (the limiter is preserved as-is).
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: username, password })
    });
    if (res.status !== 429) break;
    await sleep(15_000);
  }
  if (!res || !res.ok) throw new Error(`login failed for ${username}: HTTP ${res?.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /linkup_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`no session cookie for ${username}`);
  const cookie = `linkup_session=${match[1]}`;
  const json = (await res.json()) as {
    data?: { userId?: string; user?: { id: string } };
    user?: { id: string };
  };
  const id = json.data?.userId ?? json.data?.user?.id ?? json.user?.id;
  return {
    id: id ?? '',
    username,
    cookie,
    headers: { 'Content-Type': 'application/json', Cookie: cookie }
  };
}

export async function api<T = Record<string, unknown>>(
  s: Session,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: s.headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

export function connectSocket(s: Session): Socket {
  return io(SERVER_URL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    extraHeaders: { Cookie: s.cookie },
    reconnection: false
  });
}

/** Connect and join the given conversation rooms (post-create rejoin). */
export async function connectAndJoin(s: Session, conversationIds: string[]): Promise<Socket> {
  const sock = connectSocket(s);
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('connect_error', reject);
  });
  for (const id of conversationIds) sock.emit('conversation:join', { conversationId: id });
  await sleep(250);
  return sock;
}

export function waitFor<T>(socket: Socket, event: string, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Assert an event does NOT arrive within `ms`. Resolves true when quiet,
 * false when the event fired.
 */
export function expectQuiet(socket: Socket, event: string, ms = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const onEvent = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    socket.on(event, onEvent);
  });
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createReporter() {
  let passed = 0;
  let failed = 0;
  let blocked = 0;

  async function check(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      if (err instanceof Error && err.name === 'BrowserBlockedError') {
        // Missing browser is not a pass and not an assertion failure.
        blocked += 1;
        console.log(`  ! BLOCKED ${name}`);
        console.log(`    ${err.message.split('\n').join('\n    ')}`);
        const instructions = (err as Error & { instructions?: string }).instructions;
        if (instructions) console.log(instructions);
        return;
      }
      failed += 1;
      console.log(`  ✗ ${name}`);
      console.log(`    ${(err as Error).message.split('\n').join('\n    ')}`);
    }
  }

  function finish() {
    console.log('\n════════════════════════════════════');
    console.log(`PASSED ${passed}  FAILED ${failed}  BLOCKED ${blocked}`);
    if (failed > 0) process.exit(1);
    if (blocked > 0) process.exit(77);
    process.exit(0);
  }

  return { check, finish };
}

/** Conversation list as a plain map keyed by id. */
export async function conversationsBy(s: Session): Promise<Map<string, Record<string, unknown>>> {
  const res = await api<{ data?: { conversations?: Record<string, unknown>[] } }>(
    s,
    'GET',
    '/api/conversations'
  );
  const list = res.json.data?.conversations ?? [];
  return new Map(list.map((c) => [c.id as string, c]));
}

export interface WireMessage {
  id: string;
  conversationId: string;
  senderId: string | null;
  content: string | null;
  type: string;
  createdAt: string;
  isMine?: boolean;
  deletedAt?: string | null;
}

export async function history(s: Session, conversationId: string, limit = 50): Promise<WireMessage[]> {
  const res = await api<{ data?: { messages?: WireMessage[] } }>(
    s,
    'GET',
    `/api/conversations/${conversationId}/messages?limit=${limit}`
  );
  // API returns newest-first — chronological order is what tests reason in.
  return (res.json.data?.messages ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function sendText(
  s: Session,
  conversationId: string,
  content: string,
  nonce: string
): Promise<{ status: number }> {
  return api(s, 'POST', `/api/conversations/${conversationId}/messages`, {
    type: 'TEXT',
    content,
    clientNonce: nonce
  });
}

export function uniq(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
