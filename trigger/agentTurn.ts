import { batch, logger, metadata, task } from "@trigger.dev/sdk";

import {
  EmptyStreamError,
  type AgentMessage,
  type ToolCall,
} from "@/agent/provider";
import { OpenRouterProvider } from "@/agent/providers/openrouter";
import { prisma } from "@/db/client";
import type { ContentBlock } from "@/contracts/chat";
import { magicaTool } from "./magicaTool";
import {
  claimToolCall,
  executionKeyFor,
  type ToolExecution,
} from "@/tools/execute";
import { toOpenRouterTools } from "@/tools/registry";

export type AgentTurnPayload = {
  chatId: string;
  runId: string;
  assistantMessageId: string;
  userAccountId: string;
  traceId: string;
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
        ...extra,
      });

    await prisma.agentRun.update({
      where: { id: payload.runId },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    metadata.set("status", "running");

    try {
      const history = await restoreConversation(
        payload.chatId,
        payload.assistantMessageId,
      );

      log("conversation restored", { messages: history.length });

      const provider = new OpenRouterProvider();
      const tools = toOpenRouterTools();
      const conversation: AgentMessage[] = [...history];
      const blocks: ContentBlock[] = [];

      let text = "";
      let routedModel: string | null = null;
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      let turns = 0;

      for (turns = 1; turns <= MAX_TURNS; turns += 1) {
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

          if (chunk.type === "text") {
            turnText += chunk.text;
            text += chunk.text;
            metadata.set("streamedCharacters", text.length);
          } else {
            routedModel = chunk.routedModel ?? routedModel;
            // Usage is per model call; the turn total is what the run records.
            usage = addUsage(usage, chunk.usage);
            toolCalls = chunk.toolCalls;
          }
        }

        if (turnText) blocks.push({ type: "text", text: turnText });

        if (signal?.aborted || toolCalls.length === 0) break;

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

        if (signal?.aborted) break;
      }

      const cancelled = signal?.aborted ?? false;

      // Terminal state lands in one transaction: a client that reads after this
      // commit sees a complete turn, never a half-written one.
      await prisma.$transaction([
        prisma.message.update({
          where: { id: payload.assistantMessageId },
          data: {
            content: text,
            contentBlocks: blocks.length > 0 ? (blocks as never) : undefined,
            status: cancelled ? "CANCELLED" : "SUCCESS",
            tokenUsage: usage ?? undefined,
            aiModel: routedModel
              ? { id: routedModel, name: routedModel, provider: "openrouter" }
              : undefined,
            metadata: { turns, thinkingDurationSeconds: null },
          },
        }),
        prisma.agentRun.update({
          where: { id: payload.runId },
          data: {
            status: cancelled ? "CANCELLED" : "COMPLETED",
            routedModel,
            turns,
            completedAt: new Date(),
          },
        }),
      ]);

      metadata.set("status", cancelled ? "cancelled" : "completed");
      log("turn finished", { cancelled, characters: text.length, turns });

      return { runId: payload.runId, characters: text.length };
    } catch (error) {
      await failRun(payload, error);
      throw error;
    }
  },
});

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
): Promise<Map<string, ToolExecution>> {
  const executions = new Map<string, ToolExecution>();
  const pending: {
    toolCallId: string;
    payload: Parameters<typeof magicaTool.trigger>[0];
    idempotencyKey: string;
  }[] = [];

  for (const call of toolCalls) {
    const claim = await claimToolCall({
      runId: payload.runId,
      messageId: payload.assistantMessageId,
      toolName: call.name,
      toolCallId: call.id,
      rawInput: call.input,
    });

    if (claim.status === "settled") {
      executions.set(call.id, claim.execution);
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
        nodeType: claim.nodeType,
        nodeInput: claim.nodeInput,
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
      executions.set(item.toolCallId, run.output);
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
      invocationId: item.payload.invocationId,
      state: "FAILED",
      result: null,
      errorCode: "tool_task_failed",
      userMessage: "That step could not be completed.",
      creditUsed: 0,
      deduped: false,
    });
  });

  return executions;
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

  const userMessage = isEmptyStream
    ? "The model returned an empty response. Try sending the message again."
    : "This turn failed before it finished. You can retry it.";

  // An empty stream or an upstream 429/5xx is worth retrying; a malformed
  // request is not, and offering a retry that always fails is worse than
  // offering none.
  const retryable =
    isEmptyStream ||
    (error instanceof Error &&
      /openrouter_http_(429|5\d\d)/.test(error.message));

  logger.error("turn failed", {
    chatId: payload.chatId,
    runId: payload.runId,
    traceId: payload.traceId,
    errorCode,
  });

  await prisma.$transaction([
    prisma.message.update({
      where: { id: payload.assistantMessageId },
      data: { status: "FAILED" },
    }),
    prisma.agentRun.update({
      where: { id: payload.runId },
      data: {
        status: "FAILED",
        errorCode,
        userMessage,
        retryable,
        completedAt: new Date(),
      },
    }),
  ]);

  metadata.set("status", "failed");
}
