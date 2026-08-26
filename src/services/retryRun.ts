import { prisma } from "@/db/client";
import { ensureRunDispatched } from "@/services/dispatchRun";
import { isTerminal } from "@/services/runs";

/**
 * Runs a failed turn again, on the same run.
 *
 * Reusing the run rather than opening a new one is what makes retry safe. The
 * user's message is never written twice because it is not written at all — it
 * is already there. Paid work is never repeated because `ToolInvocation`
 * execution keys are derived from `${runId}:${toolCallId}`, so a tool that
 * already completed is found and replayed from its row instead of being
 * dispatched to Magica a second time.
 *
 * The attempt counter is what lets Trigger tell two dispatches of the same run
 * apart. Without it the platform's own idempotency would silently swallow the
 * retry and report success while nothing ran.
 */

export type RetryOutcome = {
  runId: string;
  chatId: string;
  messageId: string;
  status: string;
  retried: boolean;
  attempt: number;
  realtimeRunId: string | null;
  realtimeToken: string;
  reason: "not_retryable" | "run_active" | "already_retried" | null;
};

/** Null means the run does not exist, or belongs to somebody else. */
export async function retryRun(options: {
  userAccountId: string;
  runId: string;
  sessionId?: string | null;
}): Promise<RetryOutcome | null> {
  const run = await prisma.agentRun.findFirst({
    where: { id: options.runId, chat: { userId: options.userAccountId } },
    select: {
      id: true,
      chatId: true,
      status: true,
      retryable: true,
      attempt: true,
      triggerRunId: true,
      messages: {
        where: { role: "ASSISTANT" },
        orderBy: { sequence: "asc" },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!run) return null;

  const assistantMessageId = run.messages[0]?.id;

  const refuse = (reason: RetryOutcome["reason"]): RetryOutcome => ({
    runId: run.id,
    chatId: run.chatId,
    messageId: assistantMessageId ?? "",
    status: run.status,
    retried: false,
    attempt: run.attempt,
    realtimeRunId: run.triggerRunId,
    realtimeToken: "",
    reason,
  });

  // A run still doing work is not a failure to retry; the client should watch
  // the one that is already going.
  if (!isTerminal(run.status)) return refuse("run_active");

  // Only failures the worker itself marked retryable. A malformed request or a
  // rejected tool reproduces exactly, and offering a button that always fails
  // is worse than offering none.
  if (!run.retryable || !assistantMessageId) return refuse("not_retryable");

  const nextAttempt = run.attempt + 1;
  const traceId = crypto.randomUUID();

  // The conditional update is the idempotency: two simultaneous clicks both
  // read a terminal run, and exactly one of them writes the new attempt. No
  // client-supplied key is needed because the run's own state is the token.
  const claimed = await prisma.agentRun.updateMany({
    where: { id: run.id, attempt: run.attempt, status: run.status },
    data: {
      status: "QUEUED",
      attempt: nextAttempt,
      errorCode: null,
      userMessage: null,
      retryable: false,
      startedAt: null,
      completedAt: null,
      // The previous trigger run is finished; a stale id would let the client
      // subscribe to a run that will never emit again.
      triggerRunId: null,
      dispatchingAt: null,
      traceId,
    },
  });

  if (claimed.count === 0) return refuse("already_retried");

  // The turn rewrites content from scratch on every attempt, so the placeholder
  // is reset rather than appended to. Tool invocation rows are left alone: they
  // are the record of what was already paid for.
  await prisma.message.update({
    where: { id: assistantMessageId },
    data: { status: "PENDING", content: "", contentBlocks: undefined },
  });

  const dispatch = await ensureRunDispatched(
    run.id,
    options.sessionId ?? null,
  ).catch(() => null);

  return {
    runId: run.id,
    chatId: run.chatId,
    messageId: assistantMessageId,
    status: "QUEUED",
    retried: true,
    attempt: nextAttempt,
    realtimeRunId: dispatch?.triggerRunId ?? null,
    realtimeToken: dispatch?.realtimeToken ?? "",
    reason: null,
  };
}
