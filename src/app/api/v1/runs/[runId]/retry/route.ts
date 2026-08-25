import { RetryRunResponseSchema } from "@/contracts/chat";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { retryRun } from "@/services/retryRun";

/**
 * Runs a failed turn again.
 *
 * Refusals are 200 with `retried: false` and a reason, not errors: a stale tab
 * clicking retry on a run somebody already retried should reconcile to the
 * current state, not render a failure on top of a failure. Only a run that does
 * not exist — or is not the caller's — is a 404, and those two are deliberately
 * the same answer.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace, sessionId }) => {
    const { runId } = await context.params;
    const outcome = await retryRun({ userAccountId, runId, sessionId });

    if (!outcome) return errorResponse("NOT_FOUND", { trace });

    return jsonResponse(RetryRunResponseSchema.parse(outcome), {
      status: outcome.retried ? 202 : 200,
      trace,
    });
  });
}
