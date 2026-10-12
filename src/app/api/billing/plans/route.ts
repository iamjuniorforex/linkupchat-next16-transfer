import { publicPlans } from '@/lib/billing';
import { ok, withError } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = withError(async () => ok(await publicPlans()));
