-- Phase 15: per-status audience, reactions, replies, and author archive.
-- Additive only. Existing rows keep the previous contacts-only behavior.

CREATE TYPE "StatusAudience" AS ENUM ('CONTACTS', 'CONTACTS_EXCEPT', 'ONLY_SHARE');

ALTER TABLE "Status" ADD COLUMN "audience" "StatusAudience" NOT NULL DEFAULT 'CONTACTS';
ALTER TABLE "Status" ADD COLUMN "fontStyle" TEXT;
ALTER TABLE "Status" ADD COLUMN "textColor" TEXT;
ALTER TABLE "Status" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Status_userId_archivedAt_idx" ON "Status"("userId", "archivedAt");

CREATE TABLE "StatusAudienceMember" (
    "id" TEXT NOT NULL,
    "statusId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "StatusAudienceMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StatusAudienceMember_statusId_userId_key" ON "StatusAudienceMember"("statusId", "userId");
CREATE INDEX "StatusAudienceMember_userId_idx" ON "StatusAudienceMember"("userId");

ALTER TABLE "StatusAudienceMember" ADD CONSTRAINT "StatusAudienceMember_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusAudienceMember" ADD CONSTRAINT "StatusAudienceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StatusReaction" (
    "id" TEXT NOT NULL,
    "statusId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StatusReaction_statusId_userId_key" ON "StatusReaction"("statusId", "userId");
CREATE INDEX "StatusReaction_userId_idx" ON "StatusReaction"("userId");

ALTER TABLE "StatusReaction" ADD CONSTRAINT "StatusReaction_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusReaction" ADD CONSTRAINT "StatusReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StatusReply" (
    "id" TEXT NOT NULL,
    "statusId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusReply_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StatusReply_messageId_key" ON "StatusReply"("messageId");
CREATE INDEX "StatusReply_statusId_senderId_idx" ON "StatusReply"("statusId", "senderId");

ALTER TABLE "StatusReply" ADD CONSTRAINT "StatusReply_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusReply" ADD CONSTRAINT "StatusReply_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusReply" ADD CONSTRAINT "StatusReply_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
