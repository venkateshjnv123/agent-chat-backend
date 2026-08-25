import { logger, metadata, task } from "@trigger.dev/sdk";

import { runClaimedTool, type ToolExecution } from "@/tools/execute";

export type MagicaToolPayload = {
  invocationId: string;
  nodeType: string;
  nodeInput: Record<string, unknown>;
  /** For log correlation only; the row is the source of truth. */
  runId: string;
  traceId: string;
};

/**
 * One Magica model run, as a durable child task.
 *
 * Media work takes minutes, and running it inline would hold the agent turn's
 * execution slot open for the whole wait — the orchestrator would be blocked on
 * I/O rather than orchestrating. As a child task the parent checkpoints while
 * this runs, which is what lets many turns be in flight at once.
 *
 * The task is deliberately generic: it takes a nodeType and a mapped input, so
 * adding a tool means adding a registry entry, never a new task file.
 *
 * Retries are disabled. Every outcome, including failure, is already persisted
 * on the ToolInvocation row by `runClaimedTool`, and a provider run that has
 * been paid for must not be dispatched twice by an automatic retry.
 */
export const magicaTool = task({
  id: "magica-tool",
  // Well past the slowest observed run (a two-clip merge takes ~110s) without
  // letting a wedged provider run hold a machine indefinitely.
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  run: async (
    payload: MagicaToolPayload,
    { signal },
  ): Promise<ToolExecution> => {
    metadata.set("status", "running");
    metadata.set("nodeType", payload.nodeType);

    const execution = await runClaimedTool({
      invocationId: payload.invocationId,
      nodeType: payload.nodeType,
      nodeInput: payload.nodeInput,
      signal,
    });

    logger.info("tool finished", {
      runId: payload.runId,
      traceId: payload.traceId,
      invocationId: payload.invocationId,
      nodeType: payload.nodeType,
      state: execution.state,
      creditUsed: execution.creditUsed,
    });

    metadata.set("status", execution.state.toLowerCase());

    return execution;
  },
});
