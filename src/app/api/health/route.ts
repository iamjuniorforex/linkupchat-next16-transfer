import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Lightweight health check for hosting platforms and load balancers.
 * Verifies the API is up and the database is reachable.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return ok({
      status: 'healthy',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch {
    return fail('DB_UNAVAILABLE', 'Database is not reachable.', 503);
  }
}
