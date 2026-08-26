import { logger, metadata, task } from "@trigger.dev/sdk";

import { runClaimedTool, type ToolExecution } from "@/tools/execute";

export type MagicaToolPayload = {
  invocationId: string;
  /** Whose credit the parent reserved, and who settlement returns it to. */
  ownerId: string;
  nodeType: string;
  nodeInput: Record<string, unknown>;
  /** Microcredits already held by the parent for this step. */
  reserved: number;
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
  // Video generation and multi-clip merges can legitimately exceed ten
  // minutes under provider load. Keep this above the polling deadline so the
  // child can persist a clean timeout instead of being killed mid-settlement.
  maxDuration: 20 * 60,
  retry: { maxAttempts: 1 },
  run: async (
    payload: MagicaToolPayload,
    { signal },
  ): Promise<ToolExecution> => {
    metadata.set("status", "running");
    metadata.set("nodeType", payload.nodeType);

    const execution = await runClaimedTool({
      invocationId: payload.invocationId,
      ownerId: payload.ownerId,
      runId: payload.runId,
      nodeType: payload.nodeType,
      nodeInput: payload.nodeInput,
      reserved: payload.reserved,
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
