import { db } from '@/lib/db';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { withAuth, ok, ApiError, readJson } from '@/lib/api';
import { z } from 'zod';
import { canSeePrivacy, assertNotBlocked } from '@/lib/serialize';
import type { ContactDTO } from '@/types';

export const dynamic = 'force-dynamic';

/** My contact list. */
export const GET = withAuth(async (_req, user) => {
  const contacts = await db.contact.findMany({
    where: { ownerId: user.id },
    include: {
      contact: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          about: true,
          isOnline: true,
          lastSeenAt: true,
          settings: {
            select: {
              privacyProfilePhoto: true,
              privacyAbout: true,
              privacyOnline: true,
              privacyLastSeen: true
            }
          }
        }
      }
    },
    orderBy: { contact: { displayName: 'asc' } }
  });

  const dto: ContactDTO[] = contacts.map((c) => {
    const s = c.contact.settings;
    const seePhoto = canSeePrivacy(s?.privacyProfilePhoto, true);
    const seeAbout = canSeePrivacy(s?.privacyAbout, true);
    const seeOnline = canSeePrivacy(s?.privacyOnline, true);
    const seeLastSeen = canSeePrivacy(s?.privacyLastSeen, true);
    return {
      id: c.id,
      nickname: c.nickname,
      createdAt: c.createdAt.toISOString(),
      user: {
        id: c.contact.id,
        username: c.contact.username,
        displayName: c.contact.displayName,
        avatarUrl: seePhoto ? c.contact.avatarUrl : null,
        about: seeAbout ? c.contact.about : '',
        isOnline: seeOnline ? c.contact.isOnline : false,
        lastSeenAt: seeLastSeen ? c.contact.lastSeenAt?.toISOString() ?? null : null
      }
    };
  });

  return ok({ contacts: dto });
});

const addSchema = z.object({ userId: z.string() });

/** Add a contact. */
export const POST = withAuth(async (req, user) => {
  enforceUserRateLimit(user.id, 'contact:add', 30);
  const body = addSchema.parse(await readJson(req));
  if (body.userId === user.id) throw new ApiError('VALIDATION_ERROR', 'You cannot add yourself.', 422);

  const target = await db.user.findUnique({
    where: { id: body.userId },
    include: { settings: { select: { privacyAddMe: true } } }
  });
  if (!target || target.status === 'BANNED') throw new ApiError('USER_NOT_FOUND', 'User not found.', 404);
  await assertNotBlocked(user.id, target.id);
  const addMe = target.settings?.privacyAddMe ?? 'EVERYONE';
  if (addMe === 'NOBODY') {
    throw new ApiError('FORBIDDEN', 'This person is not accepting new contacts.', 403);
  }
  if (addMe === 'CONTACTS') {
    const theySavedMe = await db.contact.findFirst({
      where: { ownerId: target.id, contactId: user.id },
      select: { id: true }
    });
    if (!theySavedMe) {
      throw new ApiError('FORBIDDEN', 'This person only accepts contacts they already know.', 403);
    }
  }

  const contact = await db.contact.upsert({
    where: { ownerId_contactId: { ownerId: user.id, contactId: body.userId } },
    update: {},
    create: { ownerId: user.id, contactId: body.userId }
  });

  return ok({ contactId: contact.id, added: true }, { status: 201 });
});

const removeSchema = z.object({ userId: z.string() });

/** Remove a contact. */
export const DELETE = withAuth(async (req, user) => {
  const body = removeSchema.parse(await readJson(req));
  await db.contact.deleteMany({ where: { ownerId: user.id, contactId: body.userId } });
  return ok({ removed: true });
});
