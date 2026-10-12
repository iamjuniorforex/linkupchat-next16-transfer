-- Dedupe any retries that duplicated before the constraint existed: keep the
-- oldest message per (conversationId, clientNonce); clear the retry key on
-- later duplicates so the unique constraint can be applied.
UPDATE "Message" m SET "clientNonce" = NULL
WHERE m."clientNonce" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Message" older
    WHERE older."conversationId" = m."conversationId"
      AND older."clientNonce" = m."clientNonce"
      AND (older."createdAt" < m."createdAt"
           OR (older."createdAt" = m."createdAt" AND older."id" < m."id"))
  );

-- DropIndex
DROP INDEX "Message_clientNonce_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_clientNonce_key" ON "Message"("conversationId", "clientNonce");
