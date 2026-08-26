import { runs } from "@trigger.dev/sdk";

import { prisma } from "@/db/client";
import { finalizeCancelledRun } from "@/services/cancelRun";

const PROBE_INTERVAL_MS = 15_000;
const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "CANCELLING"] as const;
const TERMINAL_TRIGGER_STATUSES = [
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
] as const;

type ReconciliableRun = {
  id: string;
  status: string;
  triggerRunId: string | null;
  updatedAt: Date;
};

/**
 * Repairs the database when Trigger terminates before task code can persist.
 *
 * The `updatedAt` compare-and-swap is a distributed probe lease. Browser
 * polling may hit several serverless instances, but at most one asks Trigger
 * about the run in each interval.
 */
export async function reconcileTriggerTerminalState<T extends ReconciliableRun>(
  run: T,
  now = new Date(),
): Promise<T> {
  if (
    !run.triggerRunId ||
    !(ACTIVE_STATUSES as readonly string[]).includes(run.status) ||
    now.getTime() - run.updatedAt.getTime() < PROBE_INTERVAL_MS
  ) {
    return run;
  }

  const probe = await prisma.agentRun.updateMany({
    where: {
      id: run.id,
      triggerRunId: run.triggerRunId,
      status: { in: [...ACTIVE_STATUSES] },
      updatedAt: run.updatedAt,
    },
    data: { updatedAt: now },
  });

  if (probe.count === 0) return readCurrent(run);

  let triggerStatus: string;

  try {
    triggerStatus = (await runs.retrieve(run.triggerRunId)).status;
  } catch {
    return readCurrent(run);
  }

  if (
    !(TERMINAL_TRIGGER_STATUSES as readonly string[]).includes(triggerStatus)
  ) {
    return readCurrent(run);
  }

  if (triggerStatus === "CANCELED" || run.status === "CANCELLING") {
    await finalizeCancelledRun(run.id, now);
    return readCurrent(run);
  }

  await prisma.$transaction(async (tx) => {
    const failed = await tx.agentRun.updateMany({
      where: { id: run.id, status: { in: [...ACTIVE_STATUSES] } },
      data: {
        status: "FAILED",
        completedAt: now,
        retryable: true,
        errorCode: `trigger_${triggerStatus.toLowerCase()}`,
        userMessage: "This turn stopped before finishing. You can retry it.",
      },
    });

    if (failed.count === 0) return;

    await tx.message.updateMany({
      where: {
        runId: run.id,
        role: "ASSISTANT",
        status: { in: ["PENDING", "STREAMING"] },
      },
      data: { status: "FAILED" },
    });
    await tx.waitpoint.updateMany({
      where: { runId: run.id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
  });

  return readCurrent(run);
}

async function readCurrent<T extends ReconciliableRun>(
  fallback: T,
): Promise<T> {
  return (
    ((await prisma.agentRun.findUnique({
      where: { id: fallback.id },
    })) as T | null) ?? fallback
  );
}
