import { CancelRunResponseSchema } from "@/contracts/chat";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { requestRunCancellation } from "@/services/cancelRun";

/**
 * Cancels an in-flight run.
 *
 * Idempotent by design: cancelling an already-terminal run reports the existing
 * state rather than erroring, so a double-click or a retried request is safe.
 * The worker checks the abort signal between chunks and persists whatever it
 * produced before stopping.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { runId } = await context.params;
    const outcome = await requestRunCancellation(userAccountId, runId);

    if (!outcome) return errorResponse("NOT_FOUND", { trace });

    return jsonResponse(CancelRunResponseSchema.parse(outcome), { trace });
  });
}
