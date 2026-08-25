import { prisma } from "@/db/client";

/**
 * Recovery for runs whose worker died without writing a terminal state.
 *
 * The partial unique index that guarantees one active run per chat is also the
 * failure mode: a worker killed mid-turn leaves a `RUNNING` row behind, and
 * every later send on that chat gets a 409 for a run nobody is executing. The
 * chat is then permanently unusable, which is a far worse outcome than the
 * duplicate the index exists to prevent.
 *
 * So the lock is treated as a lease. Past the deadline the row is marked failed
 * and retryable, which releases the index and leaves an explanation in the
 * transcript rather than a silent gap.
 *
 * `WAITING` is deliberately exempt. A plan waiting on a person is not stalled —
 * it is doing exactly what it should — and it carries its own one-hour expiry.
 */

/**
 * How long a run may hold the lock without finishing.
 *
 * The task's own `maxDuration` is 300s, so anything past this either crashed
 * without unwinding or was lost between the API and the worker.
 */
const LEASE_MS = 10 * 60 * 1000;

/** Statuses that hold the one-active-run lock and are expected to progress. */
const HOLDS_LOCK = ["QUEUED", "RUNNING"] as const;

export type ReclaimResult = {
  reclaimed: boolean;
  runId: string | null;
};

/**
 * Fails the chat's active run if its lease has expired.
 *
 * Returns whether anything was released, so the caller can retry the write that
 * the stale lock rejected instead of handing the user a 409 they cannot clear.
 */
export async function reclaimStaleRun(
  chatId: string,
  now = new Date(),
): Promise<ReclaimResult> {
  const active = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: [...HOLDS_LOCK] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, startedAt: true, createdAt: true },
  });

  if (!active) return { reclaimed: false, runId: null };

  // A queued run has no `startedAt`; the lease runs from when it was accepted.
  const heldSince = active.startedAt ?? active.createdAt;

  if (now.getTime() - heldSince.getTime() < LEASE_MS) {
    return { reclaimed: false, runId: active.id };
  }

  // Conditional on the status we read: a worker that came back to life between
  // the read and the write owns the run, and must not have it failed under it.
  const released = await prisma.agentRun.updateMany({
    where: { id: active.id, status: { in: [...HOLDS_LOCK] } },
    data: {
      status: "FAILED",
      errorCode: "run_lease_expired",
      userMessage: "This turn stopped without finishing. You can retry it.",
      retryable: true,
      completedAt: now,
    },
  });

  if (released.count === 0) return { reclaimed: false, runId: active.id };

  // The placeholder has to move too, or the chat renders a message that streams
  // forever.
  await prisma.message.updateMany({
    where: {
      runId: active.id,
      role: "ASSISTANT",
      status: { in: ["PENDING", "STREAMING"] },
    },
    data: { status: "FAILED" },
  });

  console.warn(
    JSON.stringify({
      level: "warn",
      message: "reclaimed stale run",
      chatId,
      runId: active.id,
      heldForMs: now.getTime() - heldSince.getTime(),
    }),
  );

  return { reclaimed: true, runId: active.id };
}
