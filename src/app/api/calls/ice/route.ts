import { withAuth, ok } from '@/lib/api';
import { getIceConfig } from '@/lib/ice-config';

export const dynamic = 'force-dynamic';

/**
 * Phase 4E — minimal ICE-server configuration for calling clients.
 *
 * Requires a logged-in user (withAuth). Returns ONLY the ICE servers needed
 * to build an RTCPeerConnection plus two non-secret capability booleans:
 * no database URLs, storage keys, session secrets, or unrelated environment.
 * TURN credentials (when configured) are visible to authenticated users —
 * inherent to static TURN credentials — and are never logged or rendered
 * into HTML. Never cached: `no-store`.
 */
export const GET = withAuth(async (_req, _user) => {
  const { iceServers, summary } = getIceConfig();
  return ok(
    {
      iceServers,
      stunConfigured: summary.stunUrlCount > 0,
      turnConfigured: summary.turnAuthConfigured
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
});
