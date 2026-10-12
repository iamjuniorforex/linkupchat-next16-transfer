-- Phase 16: profile customization and privacy controls.
-- Additive. Existing rows keep previous visibility, except phone search
-- which defaults to NOBODY so partial numbers cannot enumerate accounts.

ALTER TYPE "AttachmentKind" ADD VALUE 'COVER';

ALTER TABLE "User" ADD COLUMN "coverUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "accentColor" TEXT;
ALTER TABLE "User" ADD COLUMN "usernameChangedAt" TIMESTAMP(3);

ALTER TABLE "UserSettings" ADD COLUMN "privacyPhoneSearch" "PrivacyLevel" NOT NULL DEFAULT 'NOBODY';
ALTER TABLE "UserSettings" ADD COLUMN "privacyAddMe" "PrivacyLevel" NOT NULL DEFAULT 'EVERYONE';
ALTER TABLE "UserSettings" ADD COLUMN "privacyMessage" "PrivacyLevel" NOT NULL DEFAULT 'EVERYONE';
ALTER TABLE "UserSettings" ADD COLUMN "privacyDiscover" "PrivacyLevel" NOT NULL DEFAULT 'EVERYONE';
