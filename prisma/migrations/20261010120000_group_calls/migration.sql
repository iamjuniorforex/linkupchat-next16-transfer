-- Group calls. Additive: existing 1:1 rows keep calleeId and isGroup=false.
-- calleeId becomes nullable so a group session does not invent a fake callee.
ALTER TABLE "Call" ALTER COLUMN "calleeId" DROP NOT NULL;
ALTER TABLE "Call" ADD COLUMN "isGroup" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Call_isGroup_startedAt_idx" ON "Call"("isGroup", "startedAt" DESC);

CREATE TYPE "CallParticipantRole" AS ENUM ('HOST', 'MEMBER');
CREATE TYPE "CallParticipantStatus" AS ENUM ('INVITED', 'JOINED', 'LEFT', 'DECLINED', 'MISSED');

CREATE TABLE "CallParticipant" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CallParticipantRole" NOT NULL DEFAULT 'MEMBER',
    "status" "CallParticipantStatus" NOT NULL DEFAULT 'INVITED',
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "cameraOff" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),
    CONSTRAINT "CallParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallParticipant_callId_userId_key" ON "CallParticipant"("callId", "userId");
CREATE INDEX "CallParticipant_userId_hiddenAt_idx" ON "CallParticipant"("userId", "hiddenAt");

ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
