ALTER TABLE "Attachment" ADD COLUMN "userMessage" TEXT;
ALTER TABLE "CreditLedgerEntry" ADD COLUMN "toolInvocationId" TEXT;

-- Existing operation keys contain the invocation id between colon-delimited
-- segments. Backfill links where the run and invocation both agree.
UPDATE "CreditLedgerEntry" AS entry
SET "toolInvocationId" = invocation."id"
FROM "ToolInvocation" AS invocation
WHERE entry."runId" = invocation."runId"
  AND entry."opKey" LIKE ('%:' || invocation."id" || ':%');

CREATE INDEX "CreditLedgerEntry_toolInvocationId_idx"
  ON "CreditLedgerEntry"("toolInvocationId");

ALTER TABLE "CreditLedgerEntry"
  ADD CONSTRAINT "CreditLedgerEntry_toolInvocationId_fkey"
  FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
