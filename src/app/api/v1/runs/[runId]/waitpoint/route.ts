import { WaitpointSchema } from "@/contracts/waitpoint";
import { prisma } from "@/db/client";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { findOwnedRun } from "@/services/runs";
import { SUPPORTED_RESOLUTIONS } from "@/services/waitpoints";

/**
 * The plan a run is currently waiting on, if any.
 *
 * Realtime delivers the approval card the first time. This is how it comes back
 * after a reload: the browser cannot be trusted to have kept the payload, and
 * PostgreSQL is the only thing that knows a run is still paused.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { runId } = await context.params;
    const run = await findOwnedRun(userAccountId, runId);

    if (!run) return errorResponse("NOT_FOUND", { trace });

    const waitpoint = await prisma.waitpoint.findFirst({
      where: { runId: run.id },
      orderBy: { createdAt: "desc" },
    });

    if (!waitpoint) return errorResponse("NOT_FOUND", { trace });

    return jsonResponse(
      WaitpointSchema.parse({
        id: waitpoint.id,
        runId: waitpoint.runId,
        type: waitpoint.type,
        // A plan whose deadline passed is reported expired even if the sweep
        // has not written the row yet, so a stale overlay cannot be submitted.
        status:
          waitpoint.status === "PENDING" &&
          waitpoint.expiresAt.getTime() <= Date.now()
            ? "EXPIRED"
            : waitpoint.status,
        payload: waitpoint.payload,
        resolution: waitpoint.resolution,
        supportedResolutions: SUPPORTED_RESOLUTIONS,
        expiresAt: waitpoint.expiresAt.toISOString(),
        resolvedAt: waitpoint.resolvedAt?.toISOString() ?? null,
        createdAt: waitpoint.createdAt.toISOString(),
      }),
      { trace },
    );
  });
}
