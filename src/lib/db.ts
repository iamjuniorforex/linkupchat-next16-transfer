import { PrismaClient } from '@prisma/client';
import { mediaHref } from '@/lib/storage';

// Prisma client singleton — reused across hot reloads in development
// and across route handlers in production.

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const base =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = base;
}

/**
 * Media URLs are rewritten centrally to the authenticated `/api/files` proxy
 * (audit H-1). New uploads already store proxy URLs; this also heals legacy
 * rows written when S3/R2 objects were exposed as public bucket links — every
 * read path (messages, statuses, profiles, conversations) gets the safe URL
 * without a data migration.
 */
export const db = base.$extends({
  result: {
    attachment: {
      url: { compute: (a: { url: string }) => mediaHref(a.url) ?? '' },
      thumbnailUrl: { compute: (a: { thumbnailUrl: string | null }) => mediaHref(a.thumbnailUrl) }
    },
    user: {
      avatarUrl: { compute: (u: { avatarUrl: string | null }) => mediaHref(u.avatarUrl) }
    },
    conversation: {
      avatarUrl: { compute: (c: { avatarUrl: string | null }) => mediaHref(c.avatarUrl) }
    },
    status: {
      mediaUrl: { compute: (s: { mediaUrl: string | null }) => mediaHref(s.mediaUrl) },
      mediaThumb: { compute: (s: { mediaThumb: string | null }) => mediaHref(s.mediaThumb) }
    }
  }
  // The computed fields keep the exact base types (string → string, nullables
  // stay nullables), so the extended client is cast back to PrismaClient to
  // stay assignable to Prisma's TransactionClient (used across the app).
}) as unknown as PrismaClient;
