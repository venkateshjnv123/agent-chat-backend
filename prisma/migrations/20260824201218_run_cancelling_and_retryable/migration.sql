-- AlterEnum
ALTER TYPE "RunStatus" ADD VALUE 'CANCELLING';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "cancellationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "retryable" BOOLEAN NOT NULL DEFAULT false;
