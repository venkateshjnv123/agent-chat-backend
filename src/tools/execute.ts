import { ToolResultSchema } from "@/contracts/chat";
import { prisma } from "@/db/client";
import {
  MagicaError,
  dispatchNodeRun,
  estimateCredits,
  getNodeRun,
  isTerminal,
  type EstimateNode,
  type MagicaRun,
} from "@/magica/client";
import {
  estimateOrFallback,
  refundReservation,
  reserveCredits,
  settleCredits,
} from "@/services/creditLedger";
import { formatEstimate } from "@/services/credits";
import { getTool, sanitizeInput } from "@/tools/registry";
import { ToolOutputError, type ToolDefinition } from "@/tools/types";

/**
 * Runs one tool call end to end: validate, dispatch, poll, persist.
 *
 * The agent loop calls only this. It contains no per-tool behaviour — every
 * difference between tools lives in the registry definition — so adding a tool
 * never adds a branch here.
 *
 * Exactly-once is enforced by `ToolInvocation.executionKey`: the row is claimed
 * before the provider is called, and a replayed call finds the existing row and
 * returns it instead of dispatching again. Magica itself does not dedupe and
 * charges every duplicate dispatch, so this guard is what protects the balance.
 */

export type ToolExecution = {
  invocationId: string;
  state: "COMPLETED" | "FAILED" | "CANCELLED";
  result: unknown | null;
  errorCode: string | null;
  userMessage: string | null;
  creditUsed: number;
  /** True when a prior identical call was replayed rather than re-dispatched. */
  deduped: boolean;
};

export type ClaimToolCallOptions = {
  runId: string;
  /** Whose credit pays for this step. */
  ownerId: string;
  messageId: string | null;
  toolName: string;
  /** Provider-assigned id for this tool call; unique within the run. */
  toolCallId: string;
  rawInput: unknown;
};

export type RunClaimedToolOptions = {
  invocationId: string;
  ownerId: string;
  runId: string;
  nodeType: string;
  nodeInput: Record<string, unknown>;
  signal?: AbortSignal;
  /** Microcredits held by `claimToolCall`, settled against the real charge. */
  reserved: number;
  /** Injectable for tests; defaults to the real polling schedule. */
  poll?: PollOptions;
};

export type PollOptions = {
  timeoutMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULT_POLL: PollOptions = {
  // crop_image alone takes 10-15s; generation and merges are far slower.
  timeoutMs: 10 * 60 * 1000,
  initialDelayMs: 1_500,
  maxDelayMs: 10_000,
};

/**
 * Parent half: validate the call and claim its execution key.
 *
 * This runs in the orchestrator, before any provider call, so the unique index
 * decides who owns the execution while nothing has been spent yet. The returned
 * `execution` is set only when the work is already done — a replay — in which
 * case the caller must not dispatch a child.
 */
export async function claimToolCall(options: ClaimToolCallOptions): Promise<
  | {
      status: "claimed";
      invocationId: string;
      nodeType: string;
      nodeInput: Record<string, unknown>;
      /** Microcredits held for this step; the child settles against it. */
      reserved: number;
    }
  | { status: "settled"; execution: ToolExecution }
  | { status: "insufficient_credits"; execution: ToolExecution }
  | { status: "in_flight"; invocationId: string }
> {
  const definition = getTool(options.toolName);

  if (!definition) {
    // The model named a tool that is not in the registry. That is a failed step,
    // not a failed turn.
    return {
      status: "settled",
      execution: await persistUnclaimedFailure(options, {
        errorCode: "unknown_tool",
        userMessage: "That tool isn't available.",
      }),
    };
  }

  const parsed = definition.input.safeParse(options.rawInput);

  if (!parsed.success) {
    return {
      status: "settled",
      execution: await persistUnclaimedFailure(options, {
        errorCode: "invalid_tool_input",
        userMessage: "The tool was called with input it couldn't accept.",
      }),
    };
  }

  const input = parsed.data as Record<string, unknown>;
  const claim = await claim_(
    definition,
    options,
    executionKeyFor(options),
    input,
  );

  if (claim.replayed) {
    return claim.execution
      ? { status: "settled", execution: claim.execution }
      : { status: "in_flight", invocationId: claim.invocationId };
  }

  const nodeInput = definition.toNodeInput(parsed.data);

  // Price the step with the provider, then hold that much before dispatching.
  // Reserving after dispatch would let a user start work they cannot pay for,
  // and Magica bills at dispatch, so this is the last moment the spend can
  // still be refused.
  const reserved = await reserveStep(definition, options, claim.invocationId, {
    type: definition.nodeType,
    data: nodeInput,
  });

  if (!reserved.ok) {
    return {
      status: "insufficient_credits",
      execution: await persist(claim.invocationId, {
        state: "FAILED",
        errorCode: "insufficient_credits",
        userMessage: `This step needs ${formatEstimate(reserved.required)} credits and ${formatEstimate(reserved.available)} are available.`,
        creditUsed: 0,
        result: null,
        resultUrl: null,
      }),
    };
  }

  return {
    status: "claimed",
    invocationId: claim.invocationId,
    nodeType: definition.nodeType,
    nodeInput,
    reserved: reserved.reserved,
  };
}

/**
 * Estimates and holds credit for one step.
 *
 * A provider that will not price the step is not a reason to fail the turn: a
 * conservative fallback is reserved instead and settlement corrects it, which
 * keeps a pricing blip from looking to the user like a broken tool.
 */
async function reserveStep(
  definition: ToolDefinition,
  options: ClaimToolCallOptions,
  invocationId: string,
  node: EstimateNode,
): Promise<Awaited<ReturnType<typeof reserveCredits>>> {
  let estimate: number | null = null;

  try {
    const [priced] = await estimateCredits([node]);

    estimate = priced?.microcredits ?? null;
  } catch {
    // Logged by the client; priced by the fallback below.
    estimate = null;
  }

  return reserveCredits({
    ownerId: options.ownerId,
    runId: options.runId,
    subject: invocationId,
    amount: estimateOrFallback(estimate),
    toolName: definition.name,
    note: estimate === null ? "estimate unavailable, reserved default" : null,
  });
}

export function executionKeyFor(options: {
  runId: string;
  toolCallId: string;
}): string {
  return `${options.runId}:${options.toolCallId}`;
}

/**
 * Child half: dispatch to the provider, poll, and persist the outcome.
 *
 * Runs inside its own durable task so a ten-minute video merge does not hold
 * the orchestrator's execution slot open.
 *
 * The `externalRunId` check is what makes a task retry safe. Magica charges at
 * dispatch and does not deduplicate, so a child that crashed after dispatching
 * must resume polling the run it already paid for rather than starting a second
 * one.
 */
export async function runClaimedTool(
  options: RunClaimedToolOptions,
): Promise<ToolExecution> {
  const { invocationId } = options;

  const existing = await prisma.toolInvocation.findUnique({
    where: { id: invocationId },
    select: { toolName: true, externalRunId: true, sanitizedInput: true },
  });

  if (!existing) throw new Error("tool_invocation_missing");

  const { toolName } = existing;
  const definition = getTool(toolName);

  if (!definition) {
    return settle(
      await persist(invocationId, {
        state: "FAILED",
        errorCode: "unknown_tool",
        userMessage: "That tool isn't available.",
        creditUsed: 0,
        result: null,
        resultUrl: null,
      }),
    );
  }

  async function settle(execution: ToolExecution): Promise<ToolExecution> {
    // Settlement is keyed on the invocation, so a task retry that reaches here
    // twice writes one settlement. A step that never dispatched gets the whole
    // reservation back rather than a zero settlement — there is nothing to
    // explain when no provider run existed.
    if (execution.state === "COMPLETED" || execution.creditUsed > 0) {
      await settleCredits({
        ownerId: options.ownerId,
        runId: options.runId,
        subject: invocationId,
        reserved: options.reserved,
        actual: execution.creditUsed,
        toolName,
      });
    } else {
      await refundReservation({
        ownerId: options.ownerId,
        runId: options.runId,
        subject: invocationId,
        toolName,
        note: `step ${execution.state.toLowerCase()} before it was billed`,
      });
    }

    return execution;
  }

  let providerAccepted = Boolean(existing.externalRunId);

  try {
    let externalRunId = existing.externalRunId;

    if (!externalRunId) {
      const dispatch = await dispatchNodeRun({
        nodeType: options.nodeType,
        input: options.nodeInput,
        signal: options.signal,
      });

      externalRunId = dispatch.runId;
      providerAccepted = true;

      await prisma.toolInvocation.update({
        where: { id: invocationId },
        data: {
          state: "RUNNING",
          externalRunId,
          startedAt: new Date(),
        },
      });
    }

    const run = await pollToTerminal(externalRunId, options);

    return await settle(
      await finish(
        definition,
        invocationId,
        run,
        asRecord(existing.sanitizedInput),
      ),
    );
  } catch (error) {
    // Magica has no cancellation endpoint. Once it accepted a run, timeout or
    // parent cancellation cannot truthfully be treated as zero-cost work. Keep
    // the reservation as the conservative settled charge instead of refunding
    // locally while remote processing may continue.
    return await settle(
      await fail(invocationId, error, {
        providerAccepted,
        creditUsed: providerAccepted ? options.reserved : 0,
      }),
    );
  }
}

/**
 * Claims the execution key before any provider call.
 *
 * Ordering matters: the unique insert has to win or lose before money can be
 * spent. A lost race means the same logical call is already in flight or done,
 * and its row is the answer.
 */
async function claim_(
  definition: ToolDefinition,
  options: ClaimToolCallOptions,
  executionKey: string,
  input: Record<string, unknown>,
) {
  try {
    const created = await prisma.toolInvocation.create({
      data: {
        runId: options.runId,
        messageId: options.messageId,
        toolName: definition.name,
        rendererKey: definition.rendererKey,
        state: "PENDING",
        executionKey,
        sanitizedInput: sanitizeInput(definition, input) as never,
      },
      select: { id: true },
    });

    return { replayed: false as const, invocationId: created.id };
  } catch {
    const existing = await prisma.toolInvocation.findUnique({
      where: { executionKey },
    });

    if (!existing) throw new Error("tool_invocation_claim_failed");

    return {
      replayed: true as const,
      invocationId: existing.id,
      execution: terminalExecution(existing, true),
    };
  }
}

/** Reads a replayed paid child only after it has genuinely reached terminal. */
export async function readTerminalToolExecution(
  invocationId: string,
): Promise<ToolExecution | null> {
  const row = await prisma.toolInvocation.findUnique({
    where: { id: invocationId },
  });

  return row ? terminalExecution(row, true) : null;
}

function terminalExecution(
  row: {
    id: string;
    state: string;
    result: unknown;
    errorCode: string | null;
    userMessage: string | null;
    creditUsed: number;
  },
  deduped: boolean,
): ToolExecution | null {
  if (!["COMPLETED", "FAILED", "CANCELLED"].includes(row.state)) return null;

  return {
    invocationId: row.id,
    state: row.state as ToolExecution["state"],
    result: row.result ?? null,
    errorCode: row.errorCode,
    userMessage: row.userMessage,
    creditUsed: row.creditUsed,
    deduped,
  };
}

/**
 * Polls until the provider reaches a terminal state.
 *
 * Backoff is exponential to a ceiling: the fast first checks catch the quick
 * utility nodes, and the ceiling keeps a ten-minute video job from issuing
 * hundreds of requests. Cancellation is observed between polls, so a stopped
 * run abandons the wait rather than blocking the worker to timeout.
 */
async function pollToTerminal(
  externalRunId: string,
  options: { signal?: AbortSignal; poll?: PollOptions },
): Promise<MagicaRun> {
  const config = { ...DEFAULT_POLL, ...options.poll };
  const sleep = config.sleep ?? defaultSleep;
  const deadline = Date.now() + config.timeoutMs;

  let delay = config.initialDelayMs;

  for (;;) {
    options.signal?.throwIfAborted();

    const run = await getNodeRun(externalRunId, options.signal);

    if (isTerminal(run.status)) return run;

    if (Date.now() + delay > deadline) {
      throw new MagicaError({
        status: 504,
        code: "tool_timeout",
        message: `run ${externalRunId} did not finish within ${config.timeoutMs}ms`,
        userMessage: "That step took too long and was stopped.",
      });
    }

    await sleep(delay, options.signal);
    delay = Math.min(delay * 2, config.maxDelayMs);
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Persists a terminal provider run against our own contract. */
async function finish(
  definition: ToolDefinition,
  invocationId: string,
  run: MagicaRun,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  if (run.status !== "COMPLETED") {
    const cancelled = run.status === "CANCELLED";

    return persist(invocationId, {
      state: cancelled ? "CANCELLED" : "FAILED",
      // `run.error` is internal detail and is deliberately not persisted here;
      // only the provider's user-safe copy crosses the boundary.
      errorCode: cancelled ? "tool_cancelled" : "tool_failed",
      userMessage:
        run.userMessage ??
        (cancelled ? "That step was cancelled." : "That step failed."),
      creditUsed: run.creditUsed ?? 0,
      result: null,
      resultUrl: null,
    });
  }

  let result;

  try {
    // Parsed against the same schema the frontend uses, so a shape the renderer
    // cannot draw fails here rather than in the browser.
    result = ToolResultSchema.parse(
      definition.toResult(run.output ?? {}, input),
    );
  } catch (error) {
    const outputError = error instanceof ToolOutputError;

    return persist(invocationId, {
      state: "FAILED",
      errorCode: outputError ? error.code : "tool_result_invalid",
      userMessage: outputError
        ? error.userMessage
        : "The tool returned something we couldn't display.",
      creditUsed: run.creditUsed ?? 0,
      result: null,
      resultUrl: null,
    });
  }

  return persist(invocationId, {
    state: "COMPLETED",
    errorCode: null,
    userMessage: null,
    creditUsed: run.creditUsed ?? 0,
    result,
    resultUrl: "urls" in result ? (result.urls[0] ?? null) : null,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function fail(
  invocationId: string,
  error: unknown,
  options: { providerAccepted: boolean; creditUsed: number },
): Promise<ToolExecution> {
  if (isAbort(error)) {
    return persist(invocationId, {
      state: "CANCELLED",
      errorCode: "tool_cancelled",
      userMessage: options.providerAccepted
        ? "The chat stopped after the media provider accepted this step, so its reserved credits were kept."
        : "That step was cancelled.",
      creditUsed: options.creditUsed,
      result: null,
      resultUrl: null,
    });
  }

  const magica = error instanceof MagicaError;

  return persist(invocationId, {
    state: "FAILED",
    errorCode: magica ? error.code : "tool_dispatch_failed",
    userMessage: magica
      ? error.code === "tool_timeout" && options.providerAccepted
        ? "That step exceeded the wait limit after the provider accepted it, so its reserved credits were kept."
        : error.userMessage
      : "That step couldn't be completed.",
    creditUsed: options.creditUsed,
    result: null,
    resultUrl: null,
  });
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function persist(
  invocationId: string,
  data: {
    state: ToolExecution["state"];
    errorCode: string | null;
    userMessage: string | null;
    creditUsed: number;
    result: unknown;
    resultUrl: string | null;
  },
): Promise<ToolExecution> {
  await prisma.toolInvocation.update({
    where: { id: invocationId },
    data: {
      state: data.state,
      errorCode: data.errorCode,
      userMessage: data.userMessage,
      creditUsed: data.creditUsed,
      result: (data.result ?? null) as never,
      resultUrl: data.resultUrl,
      completedAt: new Date(),
    },
  });

  return {
    invocationId,
    state: data.state,
    result: data.result ?? null,
    errorCode: data.errorCode,
    userMessage: data.userMessage,
    creditUsed: data.creditUsed,
    deduped: false,
  };
}

/**
 * Records a step that failed before a tool could be claimed.
 *
 * Unknown names and unusable input still get a row: the step has to be visible
 * in the transcript, and the input is stored raw-but-typed only when a tool
 * definition existed to sanitise it.
 */
async function persistUnclaimedFailure(
  options: ClaimToolCallOptions,
  failure: { errorCode: string; userMessage: string },
): Promise<ToolExecution> {
  const created = await prisma.toolInvocation.create({
    data: {
      runId: options.runId,
      messageId: options.messageId,
      toolName: options.toolName,
      rendererKey: "generic",
      state: "FAILED",
      executionKey: executionKeyFor(options),
      sanitizedInput: {},
      errorCode: failure.errorCode,
      userMessage: failure.userMessage,
      completedAt: new Date(),
    },
    select: { id: true },
  });

  return {
    invocationId: created.id,
    state: "FAILED",
    result: null,
    errorCode: failure.errorCode,
    userMessage: failure.userMessage,
    creditUsed: 0,
    deduped: false,
  };
}
