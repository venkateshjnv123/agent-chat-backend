import type { Prisma } from "@/generated/prisma/client";

export const MAX_ACTIVE_RUNS_PER_USER = 5;
export const MAX_NEW_RUNS_PER_MINUTE = 30;

export class UserRunLimitError extends Error {
  constructor(
    readonly reason: "concurrency" | "rate",
    readonly retryAfterSeconds: number,
  ) {
    super(
      reason === "concurrency"
        ? "Too many active runs"
        : "Too many runs started recently",
    );
    this.name = "UserRunLimitError";
  }
}

/**
 * Serialises acceptance per owner, then enforces abuse and cost ceilings.
 *
 * The advisory transaction lock works across every serverless instance. A
 * process-memory counter would allow each instance its own limit and disappear
 * on every cold start.
 */
export async function enforceUserRunLimits(
  tx: Prisma.TransactionClient,
  ownerId: string,
  now = new Date(),
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`;

  const active = await tx.agentRun.count({
    where: {
      ownerId,
      status: { in: ["QUEUED", "RUNNING", "WAITING", "CANCELLING"] },
    },
  });

  if (active >= MAX_ACTIVE_RUNS_PER_USER) {
    throw new UserRunLimitError("concurrency", 5);
  }

  const windowStartedAt = new Date(now.getTime() - 60_000);
  const recent = await tx.agentRun.count({
    where: { ownerId, createdAt: { gte: windowStartedAt } },
  });

  if (recent >= MAX_NEW_RUNS_PER_MINUTE) {
    throw new UserRunLimitError("rate", 60);
  }
}
