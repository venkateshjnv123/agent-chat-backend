import {
  dispatchAgentTurn,
  mintRealtimeToken,
  type Dispatch,
} from "@/agent/dispatch";
import { prisma } from "@/db/client";

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
    const token = await mintRealtimeToken(run.triggerRunId);
    return { triggerRunId: run.triggerRunId, ...token };
  }

  if (run.status !== "QUEUED") return null;

  const assistantMessageId = run.messages[0]?.id;

  if (!assistantMessageId) {
    throw new Error("Accepted run has no assistant placeholder");
  }

  const dispatched = await dispatchAgentTurn({
    chatId: run.chatId,
    runId: run.id,
    assistantMessageId,
    userAccountId: run.ownerId,
    traceId: run.traceId ?? crypto.randomUUID(),
    sessionId: sessionId ?? null,
    planMode: run.planMode,
    attempt: run.attempt,
  });

  const stored = await prisma.agentRun.updateMany({
    // Do not require QUEUED here. A fast worker can enter RUNNING before this
    // write, and its handle is still required for cancellation/realtime.
    where: { id: run.id, triggerRunId: null },
    data: { triggerRunId: dispatched.triggerRunId },
  });

  if (stored.count > 0) return dispatched;

  // Another reconciler won the storage race. Return its canonical handle.
  const winner = await prisma.agentRun.findUnique({
    where: { id: run.id },
    select: { triggerRunId: true },
  });

  if (!winner?.triggerRunId) return null;

  const token = await mintRealtimeToken(winner.triggerRunId);
  return { triggerRunId: winner.triggerRunId, ...token };
}
