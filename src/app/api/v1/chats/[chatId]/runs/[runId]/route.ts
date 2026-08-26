import { findOwnedChat } from "@/auth/ownership";
import { AgentRunStateSchema } from "@/contracts/chat";
import { prisma } from "@/db/client";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { ensureRunDispatched } from "@/services/dispatchRun";

/**
 * REST reconciliation for a run.
 *
 * This is the fallback the client uses whenever realtime is not trustworthy:
 * initial mount, reconnect, token expiry, and every terminal event. Realtime is
 * delivery; this endpoint and the message rows are the truth.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ chatId: string; runId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { chatId, runId } = await context.params;

    if (!(await findOwnedChat(userAccountId, chatId))) {
      return errorResponse("NOT_FOUND", { trace });
    }

    const run = await prisma.agentRun.findFirst({
      where: { id: runId, chatId },
    });

    if (!run) return errorResponse("NOT_FOUND", { trace });

    if (run.status === "QUEUED" && !run.triggerRunId) {
      // REST polling is the durable recovery path when initial dispatch died
      // after acceptance. Delivery is idempotent and failure does not hide the
      // authoritative queued state from the client.
      await ensureRunDispatched(run.id).catch(() => null);
    }

    return jsonResponse(
      AgentRunStateSchema.parse({
        id: run.id,
        chatId: run.chatId,
        status: run.status,
        turns: run.turns,
        routedModel: run.routedModel,
        // Internal errorCode stays in the logs; only the safe message ships.
        userMessage: run.userMessage,
        retryable: run.retryable,
        cancellationRequestedAt:
          run.cancellationRequestedAt?.toISOString() ?? null,
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
      }),
      { trace },
    );
  });
}
