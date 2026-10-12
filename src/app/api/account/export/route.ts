/**
 * Account data export (production hardening, Task 2).
 *
 * POST returns the caller's complete data archive as a downloadable JSON
 * document — the versioned shape defined and assembled by
 * src/lib/account-export.ts (profile, settings, contacts, conversations,
 * messages, statuses, attachments metadata, reactions, notifications, reports
 * filed, calls, login events).
 *
 * Strictly scoped to the session's user: the payload accepts NO parameters
 * (unknown fields — e.g. a user id naming another account — are rejected), so
 * IDOR is impossible by construction. The collector never selects password
 * hashes, session tokens, verification token hashes/codes, or any other
 * server-only credentials, and minimizes other people's data to what the
 * caller already sees in the UI.
 *
 * Rate-limited per user: assembling the archive is expensive.
 */
import { NextResponse } from 'next/server';
import { withAuth, readJson } from '@/lib/api';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { exportAccountSchema } from '@/lib/validation';
import { collectAccountExport } from '@/lib/account-export';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'account-export', 5);

  await exportAccountSchema.parse(await readJson(req));

  const data = await collectAccountExport(user.id);
  const date = data.exportedAt.slice(0, 10);
  return NextResponse.json(data, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="linkupchat-export-${user.username}-${date}.json"`
    }
  });
});
