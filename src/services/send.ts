import { dispatchAgentTurn } from "@/agent/dispatch";
import { SendMessageResponseSchema } from "@/contracts/chat";
import { prisma } from "@/db/client";
import type { RequestContext } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import {
  ActiveRunExistsError,
  ChatNotFoundError,
  acceptMessage,
} from "@/services/messages";

/**
 * The one send implementation.
 *
 * Both the canonical `POST /v1/messages` and the nested
 * `POST /v1/chats/:chatId/messages` route through here, so there is a single
 * place where a run is opened and dispatched.
 */
export async function handleSend(
  context: RequestContext,
  input: { chatId?: string; content: string; idempotencyKey: string },
): Promise<Response> {
  const { userAccountId, trace } = context;

  let accepted;

  try {
    accepted = await acceptMessage({
      chatId: input.chatId,
      userAccountId,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
      traceId: trace,
    });
  } catch (error) {
    if (error instanceof ChatNotFoundError) {
      // Someone else's chat is indistinguishable from a missing one.
      return errorResponse("NOT_FOUND", { trace });
    }

    if (error instanceof ActiveRunExistsError) {
      // The partial unique index rejected a second active run on this chat.
      return errorResponse("CONFLICT", { trace });
    }

    throw error;
  }

  // A replayed send must not enqueue a second execution. The stored token is
  // still valid for the original run, so the client can resubscribe with it.
  if (accepted.replayed) {
    const run = await prisma.agentRun.findUnique({
      where: { id: accepted.runId },
      select: { triggerRunId: true },
    });

    const { mintRealtimeToken } = await import("@/agent/dispatch");
    const minted = run?.triggerRunId
      ? await mintRealtimeToken(run.triggerRunId)
      : null;

    return jsonResponse(
      SendMessageResponseSchema.parse({
        chatId: accepted.chatId,
        messageId: accepted.assistantMessageId,
        runId: accepted.runId,
        realtimeToken: minted?.realtimeToken ?? "",
      }),
      { status: 202, trace },
    );
  }

  const dispatch = await dispatchAgentTurn({
    chatId: accepted.chatId,
    runId: accepted.runId,
    assistantMessageId: accepted.assistantMessageId,
    userAccountId,
    traceId: trace,
  });

  await prisma.agentRun.update({
    where: { id: accepted.runId },
    data: { triggerRunId: dispatch.triggerRunId },
  });

  return jsonResponse(
    SendMessageResponseSchema.parse({
      chatId: accepted.chatId,
      messageId: accepted.assistantMessageId,
      runId: accepted.runId,
      realtimeToken: dispatch.realtimeToken,
    }),
    { status: 202, trace },
  );
}
