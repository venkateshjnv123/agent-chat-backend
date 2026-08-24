import { logger, metadata, task } from "@trigger.dev/sdk";

import { EmptyStreamError, type AgentMessage } from "@/agent/provider";
import { OpenRouterProvider } from "@/agent/providers/openrouter";
import { prisma } from "@/db/client";

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
 * Phase 0 runs exactly one model call. The multi-turn loop, the max-turn limit
 * and tool dispatch arrive with the registry in Phase 1; the shape here is
 * already the one that loop will fill.
 */
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
      let text = "";
      let routedModel: string | null = null;
      let usage: { inputTokens: number; outputTokens: number } | null = null;

      for await (const chunk of provider.stream({
        messages: history,
        signal,
      })) {
        // Cancellation is checked between chunks so a stopped run stops promptly
        // and still persists whatever it produced.
        if (signal?.aborted) break;

        if (chunk.type === "text") {
          text += chunk.text;
          metadata.set("streamedCharacters", text.length);
        } else {
          routedModel = chunk.routedModel;
          usage = chunk.usage;
        }
      }

      const cancelled = signal?.aborted ?? false;

      // Terminal state lands in one transaction: a client that reads after this
      // commit sees a complete turn, never a half-written one.
      await prisma.$transaction([
        prisma.message.update({
          where: { id: payload.assistantMessageId },
          data: {
            content: text,
            contentBlocks: text ? [{ type: "text", text }] : undefined,
            status: cancelled ? "CANCELLED" : "SUCCESS",
            tokenUsage: usage ?? undefined,
            aiModel: routedModel
              ? { id: routedModel, name: routedModel, provider: "openrouter" }
              : undefined,
            metadata: { turns: 1, thinkingDurationSeconds: null },
          },
        }),
        prisma.agentRun.update({
          where: { id: payload.runId },
          data: {
            status: cancelled ? "CANCELLED" : "COMPLETED",
            routedModel,
            turns: 1,
            completedAt: new Date(),
          },
        }),
      ]);

      metadata.set("status", cancelled ? "cancelled" : "completed");
      log("turn finished", { cancelled, characters: text.length });

      return { runId: payload.runId, characters: text.length };
    } catch (error) {
      await failRun(payload, error);
      throw error;
    }
  },
});

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
