-- Phase 17: master notification toggle and status preference.
-- Additive only. Existing rows default to enabled so current delivery is unchanged.
ALTER TABLE "UserSettings" ADD COLUMN "notifEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "UserSettings" ADD COLUMN "notifStatus" BOOLEAN NOT NULL DEFAULT true;
