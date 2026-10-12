import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { accessFor } from '@/lib/billing';
import { entitlementsFor } from '@/lib/entitlements';
import { validateBusinessProfile } from '@/lib/business-rules';

export const dynamic = 'force-dynamic';

function present(row: {
  name: string;
  category: string;
  description: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  greeting: string | null;
  awayMessage: string | null;
  awayEnabled: boolean;
  verificationStatus: string;
  verificationNote: string | null;
} | null) {
  if (!row) return null;
  return {
    name: row.name,
    category: row.category,
    description: row.description,
    website: row.website,
    email: row.email,
    phone: row.phone,
    greeting: row.greeting,
    awayMessage: row.awayMessage,
    awayEnabled: row.awayEnabled,
    verificationStatus: row.verificationStatus,
    verificationNote: row.verificationNote
  };
}

async function requireBusiness(userId: string) {
  const access = await accessFor(userId);
  if (!entitlementsFor(access.plan).includes('business.tools')) {
    throw new ApiError('FORBIDDEN', 'LINKUPCHAT Business is required.', 403);
  }
}

export const GET = withAuth(async (_req, user) => {
  const profile = await db.businessProfile.findUnique({ where: { userId: user.id } });
  return ok({ profile: present(profile) });
});

export const PUT = withAuth(async (req, user) => {
  await requireBusiness(user.id);
  const parsed = validateBusinessProfile(await req.json().catch(() => ({})));
  if (!parsed.ok) throw new ApiError('VALIDATION_ERROR', parsed.reason, 400);
  const saved = await db.businessProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...parsed.value },
    update: parsed.value
  });
  return ok({ profile: present(saved) });
});
