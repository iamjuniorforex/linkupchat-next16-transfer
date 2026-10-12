-- AlterTable
ALTER TABLE "ConversationMember" ADD COLUMN     "lastDeliveredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: existing rows were last updated when they were created.
UPDATE "Message" SET "updatedAt" = "createdAt";
