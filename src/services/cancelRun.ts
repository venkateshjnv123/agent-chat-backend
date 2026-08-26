import { runs } from "@trigger.dev/sdk";

import { prisma } from "@/db/client";
import { findOwnedRun, isTerminal } from "@/services/runs";

const DISPATCH_LEASE_MS = 30_000;
const CANCELLABLE = ["QUEUED", "RUNNING", "WAITING", "CANCELLING"] as const;

export type CancelOutcome = {
  runId: string;
  status: string;
  cancelled: boolean;
};

/** Null hides missing and foreign runs behind the same route response. */
export async function requestRunCancellation(
  ownerId: string,
  runId: string,
  now = new Date(),
): Promise<CancelOutcome | null> {
  const run = await findOwnedRun(ownerId, runId);

  if (!run) return null;

  if (isTerminal(run.status)) {
    return { runId: run.id, status: run.status, cancelled: false };
  }

  await prisma.agentRun.updateMany({
    where: { id: run.id, status: { in: [...CANCELLABLE] } },
    data: {
      status: "CANCELLING",
      cancellationRequestedAt: run.cancellationRequestedAt ?? now,
      userMessage: "Stopping this run…",
    },
  });

  const current = await prisma.agentRun.findUnique({
    where: { id: run.id },
    select: { triggerRunId: true, dispatchingAt: true, status: true },
  });

  if (!current) return null;
  if (isTerminal(current.status)) {
    return { runId: run.id, status: current.status, cancelled: false };
  }

  if (current.triggerRunId) {
    const delivered = await cancelTriggerAndFinalize(
      run.id,
      current.triggerRunId,
      now,
    );

    return {
      runId: run.id,
      status: delivered ? "CANCELLED" : "CANCELLING",
      cancelled: true,
    };
  }

  const dispatchLeaseActive =
    current.dispatchingAt !== null &&
    now.getTime() - current.dispatchingAt.getTime() < DISPATCH_LEASE_MS;

  if (dispatchLeaseActive) {
    return { runId: run.id, status: "CANCELLING", cancelled: true };
  }

  // No Trigger handle and no dispatch in flight: no worker can still start.
  await finalizeCancelledRun(run.id, now);
  return { runId: run.id, status: "CANCELLED", cancelled: true };
}

/** Delivers cancellation to Trigger, finalizing DB state only on acceptance. */
export async function cancelTriggerAndFinalize(
  runId: string,
  triggerRunId: string,
  now = new Date(),
): Promise<boolean> {
  try {
    await runs.cancel(triggerRunId);
  } catch {
    // Keep CANCELLING. A later request/reconciler retries delivery, and the
    // worker treats this state as cancellation even if its signal is delayed.
    return false;
  }

  await finalizeCancelledRun(runId, now);
  return true;
}

/** One terminal write used by API, dispatcher race recovery, and worker. */
export async function finalizeCancelledRun(
  runId: string,
  now = new Date(),
): Promise<void> {
  await prisma.$transaction([
    prisma.agentRun.updateMany({
      where: { id: runId, status: { in: [...CANCELLABLE] } },
      data: {
        status: "CANCELLED",
        completedAt: now,
        retryable: false,
        userMessage: "This run was cancelled.",
      },
    }),
    prisma.message.updateMany({
      where: {
        runId,
        role: "ASSISTANT",
        status: { in: ["PENDING", "STREAMING"] },
      },
      data: { status: "CANCELLED" },
    }),
    prisma.waitpoint.updateMany({
      where: { runId, status: "PENDING" },
      data: { status: "CANCELLED" },
    }),
  ]);
}
