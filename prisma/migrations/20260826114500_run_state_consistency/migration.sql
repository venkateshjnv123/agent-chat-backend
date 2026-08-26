ALTER TABLE "AgentRun"
ADD COLUMN "dispatchingAt" TIMESTAMP(3);

ALTER TABLE "Waitpoint"
ADD COLUMN "feedback" TEXT,
ADD COLUMN "resolutionKey" TEXT,
ADD COLUMN "deliveryClaimedAt" TIMESTAMP(3),
ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "deliveredAt" TIMESTAMP(3);
