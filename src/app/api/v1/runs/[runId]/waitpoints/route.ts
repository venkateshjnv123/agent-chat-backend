import { WaitpointHistorySchema } from "@/contracts/waitpoint";
import { prisma } from "@/db/client";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { findOwnedRun } from "@/services/runs";
import {
  SUPPORTED_RESOLUTIONS,
  isExecutionGraphPlan,
} from "@/services/waitpoints";

/** Complete chronological approval history for inline message rendering. */
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { runId } = await context.params;
    const run = await findOwnedRun(userAccountId, runId);
    if (!run) return errorResponse("NOT_FOUND", { trace });

    const rows = await prisma.waitpoint.findMany({
      where: { runId: run.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    return jsonResponse(
      WaitpointHistorySchema.parse({
        items: rows.map((waitpoint) => ({
          id: waitpoint.id,
          runId: waitpoint.runId,
          type: waitpoint.type,
          status:
            waitpoint.status === "PENDING" &&
            waitpoint.expiresAt.getTime() <= Date.now()
              ? "EXPIRED"
              : waitpoint.status,
          payload: waitpoint.payload,
          resolution: waitpoint.resolution,
          supportedResolutions: isExecutionGraphPlan(waitpoint.payload)
            ? SUPPORTED_RESOLUTIONS
            : ["RUN_ALL", "REQUEST_CHANGES"],
          expiresAt: waitpoint.expiresAt.toISOString(),
          resolvedAt: waitpoint.resolvedAt?.toISOString() ?? null,
          createdAt: waitpoint.createdAt.toISOString(),
        })),
      }),
      { trace },
    );
  });
}
