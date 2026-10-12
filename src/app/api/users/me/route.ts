import { db } from '@/lib/db';
import { withAuth, ok, ApiError } from '@/lib/api';
import { updateProfileSchema } from '@/lib/validation';
import { deleteStoredObject } from '@/lib/storage';
import { isProfileAccent, isReservedUsername, usernameChangeAllowed } from '@/lib/profile-privacy';

export const dynamic = 'force-dynamic';

/**
 * Edit the authenticated user's profile (Phase 5A).
 *
 * The session identity (`user.id`) is the ONLY authority for which profile is
 * edited — any client-supplied id is ignored by the schema. displayName/about/
 * username are validated by updateProfileSchema; the username is additionally
 * uniqueness-checked (race-safe). avatarUrl is never trusted as free text: it
 * must reference an AVATAR attachment this user uploaded (or null to remove),
 * which prevents arbitrary/external/javascript: URLs from ever reaching the
 * profile. Replacing a photo cleans up the previous avatar object + row.
 */
export const PATCH = withAuth(async (req, user) => {
  const body = updateProfileSchema.parse(await req.json().catch(() => ({})));

  if (body.username && body.username !== user.username) {
    if (isReservedUsername(body.username)) {
      throw new ApiError('VALIDATION_ERROR', 'That username is reserved.', 422);
    }
    const taken = await db.user.findUnique({ where: { username: body.username } });
    if (taken) throw new ApiError('USERNAME_TAKEN', 'That username is already taken.', 409);
    const current = await db.user.findUnique({
      where: { id: user.id },
      select: { username: true, usernameChangedAt: true }
    });
    const rename = usernameChangeAllowed(
      current?.username ?? user.username,
      body.username,
      current?.usernameChangedAt
    );
    if (!rename.ok) throw new ApiError('VALIDATION_ERROR', rename.message, 422);
  }

  if (body.accentColor && !isProfileAccent(body.accentColor)) {
    throw new ApiError('VALIDATION_ERROR', 'That accent color is not available.', 422);
  }

  // ── Avatar: only this user's own uploaded AVATAR attachments are valid ──
  let newAvatarUrl: string | null | undefined;
  if (body.avatarUrl !== undefined) {
    if (body.avatarUrl === null) {
      newAvatarUrl = null;
    } else {
      const attachment = await db.attachment.findFirst({
        where: { uploaderId: user.id, kind: 'AVATAR', url: body.avatarUrl }
      });
      if (!attachment) {
        throw new ApiError('INVALID_AVATAR', 'Use a photo uploaded to your profile.', 422);
      }
      newAvatarUrl = attachment.url;
    }
  }

  let newCoverUrl: string | null | undefined;
  if (body.coverUrl !== undefined) {
    if (body.coverUrl === null) {
      newCoverUrl = null;
    } else {
      const attachment = await db.attachment.findFirst({
        where: { uploaderId: user.id, kind: 'COVER', url: body.coverUrl }
      });
      if (!attachment) {
        throw new ApiError('INVALID_COVER', 'Use a cover image uploaded to your profile.', 422);
      }
      newCoverUrl = attachment.url;
    }
  }

  const previousAvatarUrl = user.avatarUrl ?? null;
  const previousCoverUrl =
    newCoverUrl !== undefined
      ? (await db.user.findUnique({ where: { id: user.id }, select: { coverUrl: true } }))?.coverUrl ?? null
      : null;

  let updated;
  try {
    updated = await db.user.update({
      where: { id: user.id }, // session identity — never a client-provided id
      data: {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.about !== undefined ? { about: body.about } : {}),
        ...(body.username !== undefined ? { username: body.username } : {}),
        ...(body.username && body.username !== user.username ? { usernameChangedAt: new Date() } : {}),
        ...(newAvatarUrl !== undefined ? { avatarUrl: newAvatarUrl } : {}),
        ...(newCoverUrl !== undefined ? { coverUrl: newCoverUrl } : {}),
        ...(body.accentColor !== undefined ? { accentColor: body.accentColor } : {})
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        about: true,
        avatarUrl: true,
        coverUrl: true,
        accentColor: true
      }
    });
  } catch (err) {
    // Unique-constraint race on username (checked above; another request won).
    if ((err as { code?: string }).code === 'P2002') {
      throw new ApiError('USERNAME_TAKEN', 'That username is already taken.', 409);
    }
    throw err;
  }

  // ── Replaced/removed photo: clean up the previous avatar object + row ──
  // Best-effort — a cleanup failure must never fail the profile update.
  if (newAvatarUrl !== undefined && previousAvatarUrl && previousAvatarUrl !== newAvatarUrl) {
    const old = await db.attachment.findFirst({
      where: { uploaderId: user.id, kind: 'AVATAR', url: previousAvatarUrl }
    });
    if (old) {
      await db.attachment
        .delete({ where: { id: old.id } })
        .then(() => deleteStoredObject(old.storageKey))
        .catch(() => {});
    }
  }
  if (newCoverUrl !== undefined && previousCoverUrl && previousCoverUrl !== newCoverUrl) {
    const old = await db.attachment.findFirst({
      where: { uploaderId: user.id, kind: 'COVER', url: previousCoverUrl }
    });
    if (old) {
      await db.attachment
        .delete({ where: { id: old.id } })
        .then(() => deleteStoredObject(old.storageKey))
        .catch(() => {});
    }
  }

  return ok(updated);
});
