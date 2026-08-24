import { mintRealtimeToken } from "@/agent/dispatch";
import { RealtimeTokenResponseSchema } from "@/contracts/chat";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { findOwnedRun } from "@/services/runs";

/**
 * Issues a fresh realtime token for a run.
 *
 * The client calls this on initial mount, after a reload, and when its current
 * token expires, rather than holding a long-lived credential. Tokens are scoped
 * to a single run, so one cannot be replayed against another user's work.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { runId } = await context.params;
    const run = await findOwnedRun(userAccountId, runId);

    if (!run) return errorResponse("NOT_FOUND", { trace });

    if (!run.triggerRunId) {
      // Dispatch has not completed yet, so there is nothing to subscribe to.
      // The client falls back to REST reconciliation and retries.
      return errorResponse("CONFLICT", {
        message: "This run has not started yet",
        trace,
      });
    }

    const { realtimeToken, expiresAt } = await mintRealtimeToken(
      run.triggerRunId,
    );

    return jsonResponse(
      RealtimeTokenResponseSchema.parse({
        runId: run.id,
        realtimeToken,
        expiresAt: expiresAt.toISOString(),
      }),
      { trace },
    );
  });
}
