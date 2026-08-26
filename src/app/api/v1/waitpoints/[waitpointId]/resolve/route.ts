import {
  ResolveWaitpointRequestSchema,
  ResolveWaitpointResponseSchema,
} from "@/contracts/waitpoint";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { WaitpointError, resolvePlanWaitpoint } from "@/services/waitpoints";

/**
 * Applies a person's decision to a paused run.
 *
 * Always a 200 when the caller owns the waitpoint, including for a duplicate
 * submit or an expired plan — `applied` carries whether anything changed. A
 * second click is not a failure, and returning an error for one would leave the
 * card in a state the user cannot clear.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ waitpointId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { waitpointId } = await context.params;
    const parsed = ResolveWaitpointRequestSchema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success) {
      return errorResponse("BAD_REQUEST", {
        issues: parsed.error.issues,
        trace,
      });
    }

    if (parsed.data.resolution === "REQUEST_CHANGES" && !parsed.data.feedback) {
      return errorResponse("BAD_REQUEST", {
        message: "Say what you want changed.",
        trace,
      });
    }

    try {
      const outcome = await resolvePlanWaitpoint({
        waitpointId,
        userAccountId,
        resolution: parsed.data.resolution,
        feedback: parsed.data.feedback,
        idempotencyKey: parsed.data.idempotencyKey,
      });

      return jsonResponse(ResolveWaitpointResponseSchema.parse(outcome), {
        trace,
      });
    } catch (error) {
      if (error instanceof WaitpointError) {
        return errorResponse(
          error.status === 400
            ? "BAD_REQUEST"
            : error.status === 409
              ? "CONFLICT"
              : "NOT_FOUND",
          {
            message: error.message,
            trace,
          },
        );
      }

      throw error;
    }
  });
}
