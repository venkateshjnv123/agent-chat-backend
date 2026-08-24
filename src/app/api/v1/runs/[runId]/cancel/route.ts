import { runs } from "@trigger.dev/sdk";

import { CancelRunResponseSchema } from "@/contracts/chat";
import { prisma } from "@/db/client";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { findOwnedRun, isTerminal } from "@/services/runs";

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
    const run = await findOwnedRun(userAccountId, runId);

    if (!run) return errorResponse("NOT_FOUND", { trace });

    if (isTerminal(run.status)) {
      return jsonResponse(
        CancelRunResponseSchema.parse({
          runId: run.id,
          status: run.status,
          cancelled: false,
        }),
        { trace },
      );
    }

    if (run.triggerRunId) {
      // Best effort: the worker may already be finishing. The database status
      // below is what the UI renders either way.
      await runs.cancel(run.triggerRunId).catch(() => undefined);
    }

    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        userMessage: "This run was cancelled.",
      },
    });

    await prisma.message.updateMany({
      where: {
        runId: run.id,
        role: "ASSISTANT",
        status: { in: ["PENDING", "STREAMING"] },
      },
      data: { status: "CANCELLED" },
    });

    return jsonResponse(
      CancelRunResponseSchema.parse({
        runId: updated.id,
        status: updated.status,
        cancelled: true,
      }),
      { trace },
    );
  });
}
