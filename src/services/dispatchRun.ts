import {
  dispatchAgentTurn,
  mintRealtimeToken,
  type Dispatch,
} from "@/agent/dispatch";
import { prisma } from "@/db/client";
import {
  cancelTriggerAndFinalize,
  finalizeCancelledRun,
} from "@/services/cancelRun";

const DISPATCH_LEASE_MS = 30_000;

/**
 * Delivers an accepted AgentRun to Trigger.
 *
 * AgentRun itself is the transactional outbox: it is committed with both
 * messages, and `triggerRunId = null` means delivery still needs doing. Trigger
 * receives a run-derived idempotency key, so two serverless reconcilers may
 * race safely and both converge on one Trigger run.
 */
export async function ensureRunDispatched(
  runId: string,
  sessionId?: string | null,
): Promise<Dispatch | null> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      chatId: true,
      ownerId: true,
      status: true,
      triggerRunId: true,
      traceId: true,
      planMode: true,
      attempt: true,
      dispatchingAt: true,
      messages: {
        where: { role: "ASSISTANT" },
        orderBy: { sequence: "asc" },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!run) return null;

  if (run.triggerRunId) {
    if (run.status === "CANCELLING" || run.status === "CANCELLED") {
      await cancelTriggerAndFinalize(run.id, run.triggerRunId);
      return null;
    }

    const token = await mintRealtimeToken(run.triggerRunId);
    return { triggerRunId: run.triggerRunId, ...token };
  }

  if (run.status !== "QUEUED") return null;

  const assistantMessageId = run.messages[0]?.id;

  if (!assistantMessageId) {
    throw new Error("Accepted run has no assistant placeholder");
  }

  const claimedAt = new Date();
  const staleBefore = new Date(claimedAt.getTime() - DISPATCH_LEASE_MS);
  const claimed = await prisma.agentRun.updateMany({
    where: {
      id: run.id,
      status: "QUEUED",
      triggerRunId: null,
      OR: [{ dispatchingAt: null }, { dispatchingAt: { lt: staleBefore } }],
    },
    data: { dispatchingAt: claimedAt },
  });

  if (claimed.count === 0) {
    const current = await prisma.agentRun.findUnique({
      where: { id: run.id },
      select: { triggerRunId: true, status: true },
    });

    if (!current?.triggerRunId) return null;

    if (current.status === "CANCELLING" || current.status === "CANCELLED") {
      await cancelTriggerAndFinalize(run.id, current.triggerRunId);
      return null;
    }

    const token = await mintRealtimeToken(current.triggerRunId);
    return { triggerRunId: current.triggerRunId, ...token };
  }

  let dispatched: Dispatch;

  try {
    dispatched = await dispatchAgentTurn({
      chatId: run.chatId,
      runId: run.id,
      assistantMessageId,
      userAccountId: run.ownerId,
      traceId: run.traceId ?? crypto.randomUUID(),
      sessionId: sessionId ?? null,
      planMode: run.planMode,
      attempt: run.attempt,
    });
  } catch (error) {
    await prisma.agentRun.updateMany({
      where: { id: run.id, triggerRunId: null, dispatchingAt: claimedAt },
      data: { dispatchingAt: null },
    });

    const current = await prisma.agentRun.findUnique({
      where: { id: run.id },
      select: { status: true },
    });

    if (current?.status === "CANCELLING") {
      await finalizeCancelledRun(run.id);
    }

    throw error;
  }

  await prisma.agentRun.updateMany({
    // Do not require QUEUED here. A fast worker can enter RUNNING before this
    // write, and its handle is still required for cancellation/realtime.
    where: { id: run.id, triggerRunId: null, dispatchingAt: claimedAt },
    data: { triggerRunId: dispatched.triggerRunId, dispatchingAt: null },
  });

  // Re-read even when this process stored the handle: cancellation may have
  // claimed the DB row while Trigger accepted the external dispatch.
  const winner = await prisma.agentRun.findUnique({
    where: { id: run.id },
    select: { triggerRunId: true, status: true },
  });

  if (!winner?.triggerRunId) return null;

  if (winner.status === "CANCELLING" || winner.status === "CANCELLED") {
    await cancelTriggerAndFinalize(run.id, winner.triggerRunId);
    return null;
  }

  // This can be our stored handle or the canonical winner of a race. Trigger's
  // idempotency makes them the same logical run either way.
  if (winner.triggerRunId === dispatched.triggerRunId) return dispatched;

  const token = await mintRealtimeToken(winner.triggerRunId);
  return { triggerRunId: winner.triggerRunId, ...token };
}
