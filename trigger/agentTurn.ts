import { batch, logger, metadata, task, wait } from "@trigger.dev/sdk";

import {
  EmptyStreamError,
  type AgentMessage,
  type ToolCall,
} from "@/agent/provider";
import { buildSystemPrompt } from "@/agent/prompt";
import { OpenRouterProvider } from "@/agent/providers/openrouter";
import { PermanentProviderError, TransientProviderError } from "@/agent/retry";
import { agentToolSchemas } from "@/agent/tools";
import { prisma } from "@/db/client";
import { estimateCredits } from "@/magica/client";
import { recordModelUsage } from "@/services/creditLedger";
import { formatEstimate } from "@/services/credits";
import { finalizeCancelledRun } from "@/services/cancelRun";
import { callFingerprint, needsPlanApproval } from "@/services/planGate";
import {
  acknowledgePlanResolution,
  createPlanWaitpoint,
  expirePlanWaitpoint,
  type PlanDecision,
} from "@/services/waitpoints";
import { getTool } from "@/tools/registry";
import type { ContentBlock } from "@/contracts/chat";
import { magicaTool } from "./magicaTool";
import { openAssistantTextStream } from "./textStream";
import {
  claimToolCall,
  executionKeyFor,
  type ToolExecution,
} from "@/tools/execute";
import type { PlanPayload } from "@/contracts/waitpoint";
import { getLocalTool, runLocalTool } from "@/skills/tools";

export type AgentTurnPayload = {
  chatId: string;
  runId: string;
  assistantMessageId: string;
  userAccountId: string;
  traceId: string;
  /** Composer plan mode: pause for approval before the first tool runs. */
  planMode?: boolean;
  /** Zero on the first dispatch; incremented by an explicit retry. */
  attempt?: number;
  /** Client session, mirrored from `x-session-id` so logs join up. */
  sessionId?: string | null;
};

/**
 * The durable unit of work for one assistant turn.
 *
 * Context is restored from Postgres at the start of every attempt rather than
 * carried in memory, so a retry, a resume after a deploy, and a first run all
 * produce the same conversation. Status rides on run metadata; the persisted
 * message is the source of truth the client reconciles against.
 *
 * A turn is a loop: the model may answer, or call tools and then answer with
 * their results. The loop knows nothing about individual tools — it asks the
 * registry for the schemas and hands each call to `executeTool` — so a new tool
 * never adds a branch here.
 */

/**
 * Ceiling on model calls in one turn.
 *
 * A model that keeps calling tools without concluding would otherwise burn
 * credits until the task hit `maxDuration`. Stopping at the ceiling leaves a
 * complete, persisted turn rather than a timeout.
 */
const MAX_TURNS = 8;
export const agentTurn = task({
  id: "agent-turn",
  maxDuration: 300,
  run: async (payload: AgentTurnPayload, { signal }) => {
    const log = (message: string, extra: Record<string, unknown> = {}) =>
      logger.info(message, {
        chatId: payload.chatId,
        runId: payload.runId,
        messageId: payload.assistantMessageId,
        traceId: payload.traceId,
        sessionId: payload.sessionId ?? null,
        attempt: payload.attempt ?? 0,
        ...extra,
      });

    const claimed = await prisma.agentRun.updateMany({
      where: {
        id: payload.runId,
        status: "QUEUED",
        attempt: payload.attempt ?? 0,
      },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    if (claimed.count === 0) {
      const current = await prisma.agentRun.findUnique({
        where: { id: payload.runId },
        select: { status: true, attempt: true },
      });

      if (current?.status === "CANCELLING") {
        await finalizeCancelledRun(payload.runId);
        metadata.set("status", "cancelled");
      }

      log("turn start ignored", {
        status: current?.status ?? "missing",
        currentAttempt: current?.attempt ?? null,
      });

      return { runId: payload.runId, characters: 0 };
    }

    metadata.set("status", "running");

    // Token-by-token delivery. Separate from run metadata so status and text
    // travel on their own channels, and best-effort so a stream that cannot
    // open never costs the turn. Opened outside the try because a failed turn
    // must close it too.
    const textStream = await openAssistantTextStream(log);

    try {
      const history = await restoreConversation(
        payload.chatId,
        payload.assistantMessageId,
      );

      log("conversation restored", { messages: history.length });

      const provider = new OpenRouterProvider();
      const tools = agentToolSchemas();
      // The system turn is rebuilt each attempt rather than persisted: it is
      // derived from the skill registry, and a resume should see the registry
      // as it is now. What the run must reproduce exactly is the guidance it
      // loaded, and RunSkill rows carry that.
      const conversation: AgentMessage[] = [
        { role: "system", content: buildSystemPrompt() },
        ...history,
      ];
      const blocks: ContentBlock[] = [];

      let text = "";
      let routedModel: string | null = null;
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      let turns = 0;
      // Set when the loop stops because it ran out of turns rather than because
      // the model was finished. The distinction is the whole point of 3.5: a
      // capped turn keeps its partial output and says why it stopped.
      let exhausted = false;
      let cancellationObserved = false;
      let lastCancellationCheck = 0;
      // Approval is scoped to the exact calls that were shown, not to the run.
      // A chained task discovers its later arguments only after the earlier
      // step has produced them, so those calls were never on the card the user
      // approved and must be presented before they can spend anything.
      const approvedCalls = new Set<string>();

      for (turns = 1; turns <= MAX_TURNS; turns += 1) {
        if (await cancellationRequested(payload.runId)) {
          cancellationObserved = true;
          break;
        }

        let turnText = "";
        let toolCalls: ToolCall[] = [];

        for await (const chunk of provider.stream({
          messages: conversation,
          tools,
          signal,
        })) {
          // Cancellation is checked between chunks so a stopped run stops
          // promptly and still persists whatever it produced.
          if (signal?.aborted) break;

          if (Date.now() - lastCancellationCheck >= 1_000) {
            lastCancellationCheck = Date.now();

            if (await cancellationRequested(payload.runId)) {
              cancellationObserved = true;
              break;
            }
          }

          if (chunk.type === "text") {
            turnText += chunk.text;
            text += chunk.text;
            textStream.push({ turn: turns, text: chunk.text });
            metadata.set("streamedCharacters", text.length);
          } else {
            routedModel = chunk.routedModel ?? routedModel;
            // Usage is per model call; the turn total is what the run records.
            usage = addUsage(usage, chunk.usage);
            toolCalls = chunk.toolCalls;
          }
        }

        if (turnText) blocks.push({ type: "text", text: turnText });

        if (signal?.aborted || cancellationObserved || toolCalls.length === 0) {
          break;
        }

        conversation.push({
          role: "assistant",
          content: turnText,
          toolCalls,
        });

        for (const call of toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: asRecord(call.input),
          });
        }

        log("tool calls requested", {
          turn: turns,
          tools: toolCalls.map((call) => call.name),
        });

        // A batch needs approval when it would spend credits on calls the user
        // has not already seen. Turns that only read local guidance cost
        // nothing and are never interrupted, which is how the reference product
        // behaves: the card appears for billable work and for nothing else.
        if (
          needsPlanApproval(toolCalls, approvedCalls) ||
          (payload.planMode && turns === 1)
        ) {
          const decision = await requestPlanApproval(payload, toolCalls, log);

          if (decision.approved) {
            for (const call of toolCalls) {
              approvedCalls.add(callFingerprint(call));
            }
          }

          if (!decision.approved) {
            // Nothing was dispatched, so nothing needs unwinding. The model is
            // told what the person said and gets another pass at the plan.
            for (const call of toolCalls) {
              executionsOf(conversation, call.id, decision.message);
            }

            blocks.push({ type: "text", text: decision.message });
            text += `\n\n${decision.message}`;

            if (decision.terminal) break;

            continue;
          }
        }

        metadata.set("status", "running_tools");

        const executions = await runToolCalls(payload, toolCalls);

        // Results are appended in the order the model asked for them, not the
        // order they finished, so a replayed conversation is byte-identical.
        for (const call of toolCalls) {
          const execution = executions.get(call.id);

          conversation.push({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify(
              execution?.state === "COMPLETED"
                ? { status: "completed", result: execution.result }
                : {
                    status: execution?.state.toLowerCase() ?? "failed",
                    // The model sees the user-safe copy only; internal codes
                    // stay in our logs and rows.
                    message:
                      execution?.userMessage ?? "That step could not be run.",
                  },
            ),
          });
        }

        if (signal?.aborted || (await cancellationRequested(payload.runId))) {
          cancellationObserved = true;
          break;
        }

        if (turns === MAX_TURNS) exhausted = true;
      }

      const cancelled = (signal?.aborted ?? false) || cancellationObserved;

      // The ceiling is reported in the transcript, not just in a log. A turn
      // that silently stops mid-plan reads to the user as the model giving up.
      if (exhausted && !cancelled) {
        const notice =
          `I stopped after ${MAX_TURNS} steps without finishing. ` +
          "Everything above already ran. Send a follow-up to continue from here.";

        blocks.push({ type: "text", text: notice });
        text += (text ? "\n\n" : "") + notice;

        log("max turns reached", { turns });
      }

      // OpenRouter Free costs us nothing, but a turn with no ledger entry looks
      // like a turn that did no work. The zero-delta row is where our decision
      // not to bill for the model is visible and auditable.
      if (usage) {
        await recordModelUsage({
          ownerId: payload.userAccountId,
          runId: payload.runId,
          subject: payload.assistantMessageId,
          model: routedModel ?? "openrouter/free",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      }

      // The text channel closes before the durable write so a subscriber stops
      // waiting for deltas and falls back to the persisted message, which is
      // about to become the complete one.
      textStream.close();

      const finalStatus = await persistTurnTerminal(payload, {
        text,
        blocks,
        usage,
        routedModel,
        turns,
        exhausted,
        cancelled,
      });

      metadata.set(
        "status",
        finalStatus === "CANCELLED"
          ? "cancelled"
          : finalStatus === "COMPLETED"
            ? "completed"
            : "failed",
      );
      log("turn finished", {
        cancelled: finalStatus === "CANCELLED",
        characters: text.length,
        turns,
      });

      return { runId: payload.runId, characters: text.length };
    } catch (error) {
      textStream.close();
      await failRun(payload, error);
      throw error;
    }
  },
});

/**
 * What the loop needs back from a tool call, whichever kind it was.
 *
 * Local and provider tools settle differently — one returns in microseconds
 * with nothing to bill, the other runs for minutes as a child task — but the
 * conversation only cares whether the step worked and what it produced.
 */
type TurnToolResult = {
  state: "COMPLETED" | "FAILED" | "CANCELLED";
  result: unknown;
  userMessage: string | null;
};

/**
 * Claims every call, then runs the ones that need work in parallel.
 *
 * Calls within a single model turn are independent by construction — a chained
 * request produces its second call in a later turn, once the first result is
 * visible — so there is nothing to serialise. Each runs as its own child task
 * and the batch waits for all of them.
 *
 * Claiming happens in this task rather than in the children: the unique index
 * has to settle who owns an execution before any child can spend money on it.
 */
async function runToolCalls(
  payload: AgentTurnPayload,
  toolCalls: ToolCall[],
): Promise<Map<string, TurnToolResult>> {
  const executions = new Map<string, TurnToolResult>();
  const pending: {
    toolCallId: string;
    payload: Parameters<typeof magicaTool.trigger>[0];
    idempotencyKey: string;
  }[] = [];

  for (const call of toolCalls) {
    // Local tools read guidance and spend nothing, so they neither claim an
    // execution key nor start a child task. This is the loop's only branch on
    // tool kind, and there is no branch anywhere on tool name.
    const local = getLocalTool(call.name);

    if (local) {
      const outcome = await runLocalTool(local, call.input, {
        runId: payload.runId,
      });

      executions.set(
        call.id,
        outcome.ok
          ? { state: "COMPLETED", result: outcome.output, userMessage: null }
          : {
              state: "FAILED",
              result: null,
              userMessage: outcome.userMessage,
            },
      );

      continue;
    }

    const claim = await claimToolCall({
      runId: payload.runId,
      ownerId: payload.userAccountId,
      messageId: payload.assistantMessageId,
      toolName: call.name,
      toolCallId: call.id,
      rawInput: call.input,
    });

    // A step that could not be afforded is settled, not dispatched. The turn
    // continues so the model can explain the shortfall and whatever already
    // succeeded is preserved.
    if (claim.status !== "claimed") {
      executions.set(call.id, toTurnResult(claim.execution));
      continue;
    }

    pending.push({
      toolCallId: call.id,
      idempotencyKey: executionKeyFor({
        runId: payload.runId,
        toolCallId: call.id,
      }),
      payload: {
        invocationId: claim.invocationId,
        ownerId: payload.userAccountId,
        nodeType: claim.nodeType,
        nodeInput: claim.nodeInput,
        reserved: claim.reserved,
        runId: payload.runId,
        traceId: payload.traceId,
      },
    });
  }

  if (pending.length === 0) return executions;

  const results = await batch.triggerAndWait<typeof magicaTool>(
    pending.map((item) => ({
      id: "magica-tool" as const,
      payload: item.payload,
      // Second layer under our unique index: a redelivered batch must not
      // enqueue the same paid execution twice.
      options: { idempotencyKey: item.idempotencyKey },
    })),
  );

  results.runs.forEach((run, index) => {
    const item = pending[index];

    if (run.ok) {
      executions.set(item.toolCallId, toTurnResult(run.output));
      return;
    }

    // The child persists its own failures, so reaching here means the task
    // itself did not complete. The row stays non-terminal and reconciliation
    // owns it; the model is told the step failed.
    logger.error("tool task did not complete", {
      runId: payload.runId,
      invocationId: item.payload.invocationId,
    });

    executions.set(item.toolCallId, {
      state: "FAILED",
      result: null,
      userMessage: "That step could not be completed.",
    });
  });

  return executions;
}

function toTurnResult(execution: ToolExecution): TurnToolResult {
  return {
    state: execution.state,
    result: execution.result,
    userMessage: execution.userMessage,
  };
}

/**
 * Tells the model a tool call was not run, without inventing a result for it.
 *
 * Every requested call needs a matching tool message or the provider rejects
 * the next request as a malformed conversation, so a plan that was declined
 * still has to answer each id.
 */
function executionsOf(
  conversation: AgentMessage[],
  toolCallId: string,
  message: string,
) {
  conversation.push({
    role: "tool",
    toolCallId,
    content: JSON.stringify({ status: "not_run", message }),
  });
}

/**
 * Pauses the run and shows its plan.
 *
 * The plan is derived from the tool calls the model actually asked for rather
 * than from a second "now write a plan" model round-trip: what the user
 * approves is then exactly what will run, and the per-step estimates are the
 * provider's real prices for those arguments.
 *
 * The wait itself is a Trigger token, so the run is checkpointed while a person
 * thinks. It costs nothing and survives a deploy.
 */
async function requestPlanApproval(
  payload: AgentTurnPayload,
  toolCalls: ToolCall[],
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<{ approved: boolean; terminal: boolean; message: string }> {
  const plan = await buildPlan(toolCalls);
  const { waitpointId, tokenId } = await createPlanWaitpoint({
    runId: payload.runId,
    plan,
  });

  await prisma.agentRun.update({
    where: { id: payload.runId },
    data: { status: "WAITING" },
  });

  // Realtime carries the card to an open tab; the row is what a reloaded tab
  // reads back from GET /v1/runs/:runId/waitpoint.
  metadata.set("status", "awaiting_approval");
  metadata.set("waitpointId", waitpointId);

  log("plan awaiting approval", {
    waitpointTokenId: tokenId,
    steps: plan.steps.length,
    totalEstimate: plan.totalEstimate,
  });

  // The deadline was set when the token was created, so a plan nobody answers
  // releases this wait as a failure rather than hanging the run forever.
  const result = await wait.forToken<PlanDecision>(tokenId);

  if (!result.ok) {
    // Expiry is terminal. Resuming an hour-old plan on nobody's authority is
    // worse than stopping and telling the user how to continue.
    await expirePlanWaitpoint(waitpointId);

    const resumed = await prisma.agentRun.updateMany({
      where: { id: payload.runId, status: "WAITING" },
      data: { status: "RUNNING" },
    });

    if (resumed.count === 0) {
      return {
        approved: false,
        terminal: true,
        message: "This run was cancelled.",
      };
    }

    metadata.set("status", "running");

    return {
      approved: false,
      terminal: true,
      message:
        "This plan expired before it was approved. Send the request again to start over.",
    };
  }

  await acknowledgePlanResolution(waitpointId, result.output);

  const resumed = await prisma.agentRun.updateMany({
    where: { id: payload.runId, status: "WAITING" },
    data: { status: "RUNNING" },
  });

  if (resumed.count === 0) {
    return {
      approved: false,
      terminal: true,
      message: "This run was cancelled.",
    };
  }

  metadata.set("status", "running");

  if (result.output.resolution === "RUN_ALL") {
    return { approved: true, terminal: false, message: "" };
  }

  return {
    approved: false,
    terminal: false,
    message: result.output.feedback
      ? `The plan was not approved. Requested changes: ${result.output.feedback}`
      : "The plan was not approved.",
  };
}

/**
 * Prices the requested calls and describes them as numbered steps.
 *
 * Local tools are left out: they read guidance, cost nothing, and listing them
 * as steps would pad the plan with work the user has no reason to weigh.
 */
async function buildPlan(toolCalls: ToolCall[]): Promise<PlanPayload> {
  const billable = toolCalls
    .map((call) => ({ call, definition: getTool(call.name) }))
    .filter(
      (
        entry,
      ): entry is {
        call: ToolCall;
        definition: NonNullable<typeof entry.definition>;
      } => entry.definition !== undefined,
    );

  let estimates: number[] = [];

  try {
    const priced = await estimateCredits(
      billable.map((entry) => ({
        type: entry.definition.nodeType,
        data: entry.definition.toNodeInput(
          entry.definition.input.parse(entry.call.input),
        ),
      })),
    );

    estimates = priced.map((entry) => entry.microcredits);
  } catch {
    // An unpriced plan is still worth approving; the steps are the point.
    estimates = billable.map(() => 0);
  }

  const steps = billable.map((entry, index) => ({
    n: index + 1,
    title: entry.definition.name.replace(/_/g, " "),
    description: entry.definition.description.split(".")[0] + ".",
    estimateCredits: estimates[index] ?? 0,
  }));

  const totalEstimate = steps.reduce(
    (sum, step) => sum + step.estimateCredits,
    0,
  );

  return {
    title:
      steps.length === 1 ? "One step to run" : `${steps.length} steps to run`,
    overview:
      "Approve to run these steps. Nothing has been charged yet — the estimate " +
      `is ${formatEstimate(totalEstimate)}.`,
    steps:
      steps.length > 0
        ? steps
        : [
            {
              n: 1,
              title: "no billable steps",
              description: "This turn only reads guidance and costs nothing.",
              estimateCredits: 0,
            },
          ],
    totalEstimate,
    notes: null,
  };
}

function addUsage(
  total: { inputTokens: number; outputTokens: number } | null,
  next: { inputTokens: number; outputTokens: number } | null,
) {
  if (!next) return total;
  if (!total) return next;

  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

/** Tool input is persisted as a content block, which requires an object. */
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

async function cancellationRequested(runId: string): Promise<boolean> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });

  return run?.status === "CANCELLING" || run?.status === "CANCELLED";
}

async function persistTurnTerminal(
  payload: AgentTurnPayload,
  outcome: {
    text: string;
    blocks: ContentBlock[];
    usage: { inputTokens: number; outputTokens: number } | null;
    routedModel: string | null;
    turns: number;
    exhausted: boolean;
    cancelled: boolean;
  },
) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.agentRun.findUnique({
      where: { id: payload.runId },
      select: { status: true, attempt: true },
    });

    if (!current) return "FAILED" as const;

    // A stale/duplicate Trigger execution cannot resurrect a terminal row or a
    // newer explicit retry attempt.
    if (
      current.attempt !== (payload.attempt ?? 0) ||
      ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)
    ) {
      return current.status;
    }

    const cancelled = outcome.cancelled || current.status === "CANCELLING";
    const status = cancelled ? ("CANCELLED" as const) : ("COMPLETED" as const);
    const updated = await tx.agentRun.updateMany({
      where: {
        id: payload.runId,
        attempt: payload.attempt ?? 0,
        status: { in: ["RUNNING", "WAITING", "CANCELLING"] },
      },
      data: {
        status,
        routedModel: outcome.routedModel,
        turns: outcome.turns,
        errorCode: outcome.exhausted && !cancelled ? "max_turns_reached" : null,
        userMessage: cancelled
          ? "This run was cancelled."
          : outcome.exhausted
            ? `This turn hit the ${MAX_TURNS}-step limit before finishing.`
            : null,
        retryable: !cancelled && outcome.exhausted,
        completedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      const winner = await tx.agentRun.findUnique({
        where: { id: payload.runId },
        select: { status: true },
      });

      return winner?.status ?? ("FAILED" as const);
    }

    await tx.message.updateMany({
      where: {
        id: payload.assistantMessageId,
        status: { in: ["PENDING", "STREAMING"] },
      },
      data: {
        content: outcome.text,
        contentBlocks:
          outcome.blocks.length > 0 ? (outcome.blocks as never) : undefined,
        status: cancelled ? "CANCELLED" : "SUCCESS",
        tokenUsage: outcome.usage ?? undefined,
        aiModel: outcome.routedModel
          ? {
              id: outcome.routedModel,
              name: outcome.routedModel,
              provider: "openrouter",
            }
          : undefined,
        metadata: {
          turns: outcome.turns,
          maxTurnsReached: outcome.exhausted,
          thinkingDurationSeconds: null,
        },
      },
    });

    return status;
  });
}

/**
 * Rebuilds the prompt from persisted rows.
 *
 * The assistant placeholder for this run is excluded — it is the row we are
 * about to fill, and feeding an empty assistant turn back to the model corrupts
 * the conversation on every retry.
 */
async function restoreConversation(
  chatId: string,
  assistantMessageId: string,
): Promise<AgentMessage[]> {
  const rows = await prisma.message.findMany({
    where: {
      chatId,
      id: { not: assistantMessageId },
      status: { in: ["SUCCESS", "STREAMING"] },
    },
    orderBy: { sequence: "asc" },
    select: { role: true, content: true },
  });

  return rows
    .filter((row) => row.content.length > 0)
    .map((row) => ({
      role: row.role === "USER" ? ("user" as const) : ("assistant" as const),
      content: row.content,
    }));
}

/**
 * Records a failure the UI can explain on its own.
 *
 * `errorCode` keeps the internal detail for logs; `userMessage` is what the
 * client renders. Keeping them apart is what stops a stack trace reaching a
 * chat bubble.
 */
async function failRun(payload: AgentTurnPayload, error: unknown) {
  const isEmptyStream = error instanceof EmptyStreamError;
  const errorCode = isEmptyStream
    ? "empty_stream"
    : error instanceof Error
      ? error.message.slice(0, 120)
      : "unknown_error";

  // Retryability comes from the provider layer's own classification rather than
  // from matching on message text here. Offering a retry that is certain to
  // fail the same way is worse than offering none, and the layer that made the
  // request is the one that knows which it was.
  const retryable =
    isEmptyStream ||
    (error instanceof TransientProviderError &&
      !(error instanceof PermanentProviderError));

  const userMessage = isEmptyStream
    ? "The model returned an empty response. Try sending the message again."
    : retryable
      ? "The model provider was unavailable. You can retry this turn."
      : "This turn failed before it finished.";

  logger.error("turn failed", {
    chatId: payload.chatId,
    runId: payload.runId,
    traceId: payload.traceId,
    errorCode,
  });

  const finalStatus = await prisma.$transaction(async (tx) => {
    const current = await tx.agentRun.findUnique({
      where: { id: payload.runId },
      select: { status: true, attempt: true },
    });

    if (!current) return "FAILED" as const;

    if (current.status === "CANCELLING") {
      await tx.agentRun.updateMany({
        where: { id: payload.runId, status: "CANCELLING" },
        data: {
          status: "CANCELLED",
          userMessage: "This run was cancelled.",
          retryable: false,
          completedAt: new Date(),
        },
      });
      await tx.message.updateMany({
        where: {
          id: payload.assistantMessageId,
          status: { in: ["PENDING", "STREAMING"] },
        },
        data: { status: "CANCELLED" },
      });

      return "CANCELLED" as const;
    }

    if (
      current.attempt !== (payload.attempt ?? 0) ||
      ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)
    ) {
      return current.status;
    }

    const updated = await tx.agentRun.updateMany({
      where: {
        id: payload.runId,
        attempt: payload.attempt ?? 0,
        status: { in: ["QUEUED", "RUNNING", "WAITING"] },
      },
      data: {
        status: "FAILED",
        errorCode,
        userMessage,
        retryable,
        completedAt: new Date(),
      },
    });

    if (updated.count > 0) {
      await tx.message.updateMany({
        where: {
          id: payload.assistantMessageId,
          status: { in: ["PENDING", "STREAMING"] },
        },
        data: { status: "FAILED" },
      });
    }

    return "FAILED" as const;
  });

  metadata.set(
    "status",
    finalStatus === "CANCELLED"
      ? "cancelled"
      : finalStatus === "COMPLETED"
        ? "completed"
        : "failed",
  );
}
