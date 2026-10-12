import { z } from 'zod';
import { isSupportedReaction } from './utils';

// Shared, server-side validation schemas (Section 37).

const usernameRegex = /^[a-z0-9_]{3,24}$/;

export const registerSchema = z.object({
  displayName: z.string().trim().min(2, 'Display name must be at least 2 characters.').max(50),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Username must be at least 3 characters.')
    .max(24)
    .regex(usernameRegex, 'Use lowercase letters, numbers and underscores only.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number.')
    .optional(),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(128)
}).refine((d) => d.email || d.phone, {
  message: 'An email or phone number is required.',
  path: ['email']
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your username, email or phone.'),
  password: z.string().min(1, 'Enter your password.'),
  remember: z.boolean().optional()
});

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your username or email.')
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(128)
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters.').max(128)
});

export const verifyEmailSchema = z.object({
  code: z.string().trim().min(4, 'Enter the code from your email.').max(12)
});

/** Resend takes no parameters — accept exactly an empty object body. */
export const resendVerificationSchema = z.object({}).strict();

/** Account export takes no parameters — accept exactly an empty object body. */
export const exportAccountSchema = z.object({}).strict();

/**
 * Account deletion requires an explicit typed confirmation AND the caller's
 * current password. Unknown fields (e.g. a user id selecting "which" account)
 * are rejected outright — the only deletable account is always the caller's.
 */
export const deleteAccountSchema = z
  .object({
    confirmation: z.string().trim().min(1).max(64),
    currentPassword: z.string().min(1, 'Enter your password.').max(128)
  })
  .strict();

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(50).optional(),
  about: z.string().trim().max(140, 'About must be 140 characters or fewer.').optional(),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(24)
    .regex(usernameRegex, 'Use lowercase letters, numbers and underscores only.')
    .optional(),
  // Profile photo: a URL that MUST reference the user's own uploaded AVATAR
  // attachment (enforced server-side in the route — never trusted as-is), or
  // null to remove the photo. Strings are bounded to avoid junk payloads.
  avatarUrl: z.string().trim().min(1).max(1024).nullable().optional(),
  coverUrl: z.string().trim().min(1).max(1024).nullable().optional(),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional()
});

export const settingsSchema = z.object({
  theme: z.enum(['LIGHT', 'DARK', 'SYSTEM']).optional(),
  enterToSend: z.boolean().optional(),
  mediaAutoDownload: z.boolean().optional(),
  wallpaper: z.string().max(40).optional(),
  notifMessages: z.boolean().optional(),
  notifGroups: z.boolean().optional(),
  notifCalls: z.boolean().optional(),
  notifSounds: z.boolean().optional(),
  notifPreview: z.boolean().optional(),
  notifEnabled: z.boolean().optional(),
  notifStatus: z.boolean().optional(),
  privacyLastSeen: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional(),
  privacyOnline: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional(),
  privacyProfilePhoto: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional(),
  privacyAbout: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional(),
  privacyStatus: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional(),
  privacyReadReceipts: z.boolean().optional(),
  privacyPhoneSearch: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional(),
  privacyAddMe: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional(),
  privacyMessage: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional(),
  privacyDiscover: z.enum(['EVERYONE', 'CONTACTS', 'NOBODY']).optional()
});

export const createConversationSchema = z.object({
  type: z.enum(['DIRECT', 'GROUP']).default('DIRECT'),
  username: z.string().trim().toLowerCase().optional(),
  memberIds: z.array(z.string()).max(256).optional(),
  title: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(300).optional()
});

export const sendMessageSchema = z.object({
  type: z
    .enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'VOICE', 'DOCUMENT', 'GIF', 'STICKER'])
    .default('TEXT'),
  content: z.string().max(8000).optional(),
  clientNonce: z.string().max(64).optional(),
  replyToId: z.string().optional(),
  attachmentIds: z.array(z.string()).max(10).optional()
});

export const editMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000)
});

export const reactionSchema = z.object({
  emoji: z.string().refine((v) => isSupportedReaction(v), {
    message: 'Unsupported reaction emoji.'
  })
});

export const statusSchema = z.object({
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO']),
  content: z.string().max(500).optional(),
  // The composer's gradient backgrounds are ~50 chars — the old 40-char cap
  // rejected every text status the UI actually posts (latent bug).
  background: z.string().max(256).optional(),
  // Phase 5B: media statuses must reference an uploaded STATUS attachment.
  // The legacy media fields are still accepted (older clients) but never
  // trusted — server-side rendering data always comes from the attachment.
  attachmentId: z.string().max(64).optional(),
  mediaUrl: z.string().max(1024).optional(),
  mediaThumb: z.string().max(1024).optional(),
  mimeType: z.string().max(80).optional(),
  audience: z.enum(['CONTACTS', 'CONTACTS_EXCEPT', 'ONLY_SHARE']).optional(),
  audienceUserIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  fontStyle: z.enum(['classic', 'serif', 'mono', 'condensed']).optional(),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
});

export const statusReactionSchema = z.object({
  emoji: z.string().min(1).max(8)
});

export const statusReplySchema = z.object({
  text: z.string().trim().min(1).max(1000),
  clientNonce: z.string().min(8).max(80).optional()
});

export const reportSchema = z.object({
  category: z.enum(['SPAM', 'HARASSMENT', 'IMPERSONATION', 'SCAM', 'INAPPROPRIATE', 'OTHER']),
  reason: z.string().trim().max(1000).optional(),
  reportedUserId: z.string().optional(),
  messageId: z.string().optional(),
  conversationId: z.string().optional()
});

// base64url (URL-safe, no padding) — the exact alphabet web-push keys use.
const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid key format.');

/** Web Push subscription (strict — anything else is rejected with 422). */
export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .url('A valid push endpoint URL is required.')
    .max(2048, 'Endpoint is too long.')
    .refine((u) => /^https:\/\//i.test(u), 'Endpoint must be an https URL (Web Push requirement).'),
  keys: z.object({
    // p256dh uncompressed point (65 bytes → 87 base64url chars); allow slack.
    p256dh: base64url(20, 512),
    // auth secret (16 bytes → 22 chars).
    auth: base64url(10, 256)
  }),
  userAgent: z.string().trim().max(256).optional()
});

export const pushUnsubscribeSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((u) => /^https:\/\//i.test(u), 'Endpoint must be an https URL (Web Push requirement).')
});

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(120)
});
