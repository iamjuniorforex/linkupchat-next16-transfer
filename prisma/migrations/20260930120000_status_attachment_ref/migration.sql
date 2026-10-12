-- Phase 5B: media statuses must reference existing uploaded media
-- (Attachment rows in the existing storage pipeline) instead of client-
-- supplied URLs. Additive only: one nullable column, unique-when-set so an
-- upload can back at most one status. Legacy string columns stay for TEXT
-- statuses and existing rows.
ALTER TABLE "Status" ADD COLUMN "attachmentId" TEXT;

CREATE UNIQUE INDEX "Status_attachmentId_key" ON "Status"("attachmentId");

ALTER TABLE "Status" ADD CONSTRAINT "Status_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
