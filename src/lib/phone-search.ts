import { db } from '@/lib/db';
import { phoneSearchDigits } from '@/lib/profile-privacy';
import { canSeePrivacy } from '@/lib/serialize';

/**
 * Exact phone lookup. Fragments never match. Missing settings mean NOBODY,
 * matching the column default, so a number is not discoverable until the
 * owner opts in.
 */
export async function phoneMatchIds(
  viewerId: string,
  query: string,
  contactIds: ReadonlySet<string>
): Promise<string[]> {
  const digits = phoneSearchDigits(query);
  if (!digits) return [];

  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM "User"
    WHERE phone IS NOT NULL
      AND id <> ${viewerId}
      AND status <> 'BANNED'
      AND regexp_replace(phone, '\\D', '', 'g') = ${digits}
    LIMIT 5
  `;
  if (!rows.length) return [];

  const settings = await db.userSettings.findMany({
    where: { userId: { in: rows.map((row) => row.id) } },
    select: { userId: true, privacyPhoneSearch: true }
  });
  const levels = new Map(settings.map((row) => [row.userId, row.privacyPhoneSearch]));
  return rows
    .filter((row) => canSeePrivacy(levels.get(row.id) ?? 'NOBODY', contactIds.has(row.id)))
    .map((row) => row.id);
}
