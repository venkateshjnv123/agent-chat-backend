-- Add owner directly to the durable dispatch row. Besides making idempotency
-- tenant-scoped, this lets recovery rebuild the Trigger payload without
-- trusting a caller-supplied user id.
ALTER TABLE "AgentRun"
ADD COLUMN "ownerId" TEXT,
ADD COLUMN "planMode" BOOLEAN NOT NULL DEFAULT false;

UPDATE "AgentRun" AS run
SET "ownerId" = chat."userId"
FROM "Chat" AS chat
WHERE run."chatId" = chat.id;

ALTER TABLE "AgentRun" ALTER COLUMN "ownerId" SET NOT NULL;

DROP INDEX "AgentRun_idempotencyKey_key";

CREATE UNIQUE INDEX "AgentRun_ownerId_idempotencyKey_key"
ON "AgentRun"("ownerId", "idempotencyKey");

CREATE INDEX "AgentRun_status_triggerRunId_createdAt_idx"
ON "AgentRun"("status", "triggerRunId", "createdAt");

ALTER TABLE "AgentRun"
ADD CONSTRAINT "AgentRun_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "UserAccount"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
