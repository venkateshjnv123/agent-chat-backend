import { dispatchAgentTurn } from "@/agent/dispatch";
import { SendMessageResponseSchema } from "@/contracts/chat";
import { prisma } from "@/db/client";
import type { RequestContext } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import {
  AttachmentError,
  bindAttachments,
  resolveReadyAttachments,
} from "@/services/attachments";
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
  input: {
    chatId?: string;
    content: string;
    idempotencyKey: string;
    planMode?: boolean;
    attachmentIds?: string[];
  },
): Promise<Response> {
  const { userAccountId, trace, sessionId } = context;

  // Resolved before anything is written. An attachment that is still uploading
  // or belongs to somebody else is a rejected request, not a persisted turn
  // that fails later with a URL the model cannot fetch.
  let attachments: { id: string; url: string }[];

  try {
    attachments = await resolveReadyAttachments({
      ownerId: userAccountId,
      attachmentIds: input.attachmentIds ?? [],
    });
  } catch (error) {
    if (error instanceof AttachmentError) {
      return errorResponse("BAD_REQUEST", {
        message: "One or more attachments aren't ready yet.",
        trace,
      });
    }

    throw error;
  }

  let accepted;

  try {
    accepted = await acceptMessage({
      chatId: input.chatId,
      userAccountId,
      // The model reads plain text, so the attachment URLs are appended to the
      // message it sees. Without this an attached image is a row in our
      // database that the agent has no way to know about.
      content: withAttachmentUrls(input.content, attachments),
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
        realtimeRunId: run?.triggerRunId ?? null,
        realtimeToken: minted?.realtimeToken ?? "",
      }),
      { status: 202, trace },
    );
  }

  if (attachments.length > 0) {
    await bindAttachments({
      chatId: accepted.chatId,
      messageId: accepted.userMessageId,
      attachmentIds: attachments.map((attachment) => attachment.id),
    });
  }

  const dispatch = await dispatchAgentTurn({
    chatId: accepted.chatId,
    runId: accepted.runId,
    assistantMessageId: accepted.assistantMessageId,
    userAccountId,
    traceId: trace,
    sessionId,
    planMode: input.planMode ?? false,
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
      realtimeRunId: dispatch.triggerRunId,
      realtimeToken: dispatch.realtimeToken,
    }),
    { status: 202, trace },
  );
}

/**
 * Appends attached image URLs to the text the model receives.
 *
 * They are numbered because order carries meaning — "crop the second one" has
 * to resolve to the same image the user reordered in the composer.
 */
function withAttachmentUrls(
  content: string,
  attachments: { url: string }[],
): string {
  if (attachments.length === 0) return content;

  const list = attachments
    .map((attachment, index) => `${index + 1}. ${attachment.url}`)
    .join("\n");

  return `${content}\n\nAttached images:\n${list}`;
}
