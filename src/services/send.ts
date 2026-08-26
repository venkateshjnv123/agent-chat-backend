import { SendMessageResponseSchema } from "@/contracts/chat";
import type { RequestContext } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import {
  AttachmentError,
  resolveReadyAttachments,
} from "@/services/attachments";
import { ensureRunDispatched } from "@/services/dispatchRun";
import {
  ActiveRunExistsError,
  AttachmentBindingError,
  ChatNotFoundError,
  acceptMessage,
} from "@/services/messages";
import { UserRunLimitError } from "@/services/runLimits";

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
      // The model reads plain text, so ordered media URLs are appended to the
      // message it sees. Without this an attachment is a row in our database
      // that the agent has no way to know about.
      content: withAttachmentUrls(input.content, attachments),
      idempotencyKey: input.idempotencyKey,
      traceId: trace,
      planMode: input.planMode ?? false,
      attachmentIds: attachments.map((attachment) => attachment.id),
      titleSource: input.content,
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

    if (error instanceof AttachmentBindingError) {
      return errorResponse("BAD_REQUEST", {
        message: "One or more attachments are already in use or unavailable.",
        trace,
      });
    }

    if (error instanceof UserRunLimitError) {
      return errorResponse("RATE_LIMITED", {
        message:
          error.reason === "concurrency"
            ? "Too many turns are already running. Wait for one to finish."
            : "Too many turns were started recently. Try again shortly.",
        trace,
        headers: { "retry-after": String(error.retryAfterSeconds) },
      });
    }

    throw error;
  }

  // Delivery can fail after the DB transaction (bad environment, network
  // outage, process death). The accepted response remains truthful: the run is
  // queued durably, and send replay / token mint / REST reconciliation all
  // retry this same idempotent outbox row.
  const dispatch = await ensureRunDispatched(accepted.runId, sessionId).catch(
    (error: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          traceId: trace,
          runId: accepted.runId,
          message: "Trigger dispatch deferred",
          reason: error instanceof Error ? error.name : "UnknownError",
        }),
      );

      return null;
    },
  );

  return jsonResponse(
    SendMessageResponseSchema.parse({
      chatId: accepted.chatId,
      messageId: accepted.assistantMessageId,
      runId: accepted.runId,
      realtimeRunId: dispatch?.triggerRunId ?? null,
      realtimeToken: dispatch?.realtimeToken ?? "",
    }),
    { status: 202, trace },
  );
}

/**
 * Appends attached media URLs to the text the model receives.
 *
 * They are numbered because order carries meaning — "merge these videos" must
 * use the same sequence the user selected in the composer.
 */
function withAttachmentUrls(
  content: string,
  attachments: { url: string }[],
): string {
  if (attachments.length === 0) return content;

  const list = attachments
    .map((attachment, index) => `${index + 1}. ${attachment.url}`)
    .join("\n");

  return `${content}\n\nAttached media (in order):\n${list}`;
}
