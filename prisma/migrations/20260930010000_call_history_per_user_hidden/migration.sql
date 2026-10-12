-- Per-user call-history visibility ("remove from my history").
-- Additive and non-destructive: two nullable timestamps, no backfill.
-- The shared Call row (duration/status/timestamps) stays intact for the other
-- participant and for system integrity.
ALTER TABLE "Call" ADD COLUMN "hiddenForCallerAt" TIMESTAMP(3);
ALTER TABLE "Call" ADD COLUMN "hiddenForCalleeAt" TIMESTAMP(3);
