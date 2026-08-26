import { beforeEach, describe, expect, it, vi } from "vitest";

import { MagicaError, type MagicaRun } from "@/magica/client";

/**
 * Execution behaviour with the provider and the database faked.
 *
 * The database fake keeps a real unique index on `executionKey`, because that
 * constraint is the entire duplicate-charge defence: a fake that let the second
 * insert through would make the test pass and the invariant untrue.
 */

const rows = new Map<string, Record<string, unknown>>();
const byKey = new Map<string, string>();
let nextId = 0;

const toolInvocation = {
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const key = data.executionKey as string;

    if (byKey.has(key)) throw new Error("unique constraint: executionKey");

    const id = `inv_${++nextId}`;
    rows.set(id, { id, creditUsed: 0, result: null, ...data });
    byKey.set(key, id);

    return { id };
  }),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = rows.get(where.id)!;
      Object.assign(row, data);
      return row;
    },
  ),
  findUnique: vi.fn(
    async ({ where }: { where: { executionKey?: string; id?: string } }) => {
      const id = where.id ?? byKey.get(where.executionKey ?? "");
      return id ? (rows.get(id) ?? null) : null;
    },
  ),
};

vi.mock("@/db/client", () => ({ prisma: { toolInvocation } }));

/**
 * Credit accounting is faked here and proven in its own suite.
 *
 * These tests are about dispatch, polling, and exactly-once execution; wiring a
 * real ledger in would make every case depend on a balance it does not care
 * about. What is asserted below is that the right settlement call happens for
 * each terminal state.
 */
const reserveCredits = vi.fn(async () => ({
  ok: true as const,
  reserved: 5_000,
  entryId: "led_1",
  replayed: false,
}));
const settleCredits = vi.fn(async () => ({
  settled: 0,
  refunded: 0,
  replayed: false,
}));
const refundReservation = vi.fn(async () => ({ refunded: 0, replayed: false }));

vi.mock("@/services/creditLedger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/creditLedger")>();

  return {
    ...actual,
    reserveCredits,
    settleCredits,
    refundReservation,
  };
});

const dispatchNodeRun = vi.fn();
const getNodeRun = vi.fn();

vi.mock("@/magica/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/magica/client")>();

  return {
    ...actual,
    dispatchNodeRun: (...args: unknown[]) => dispatchNodeRun(...args),
    estimateCredits: async () => [{ microcredits: 5_000 }],
    getNodeRun: (...args: unknown[]) => getNodeRun(...args),
  };
});

const { claimToolCall, readTerminalToolExecution, runClaimedTool } =
  await import("@/tools/execute");

const CROP_INPUT = {
  image_url: "https://x.test/in.png",
  x_percent: 10,
  y_percent: 10,
  width_percent: 50,
  height_percent: 50,
};

function magicaRun(overrides: Partial<MagicaRun> = {}): MagicaRun {
  return {
    id: "ext_1",
    nodeType: "crop_image",
    subModelId: null,
    status: "COMPLETED",
    input: {},
    output: {
      image_url: "https://x.test/out.png",
      width: 768,
      height: 512,
      creditUsed: 5000,
    },
    error: null,
    userMessage: null,
    creditUsed: 5000,
    triggerRunId: "run_1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const FAST_POLL = {
  timeoutMs: 5_000,
  initialDelayMs: 1,
  maxDelayMs: 2,
  sleep: async () => {},
};

/**
 * Claim then run, the way the orchestrator does it.
 *
 * Keeping the two halves behind one helper means these tests still describe one
 * logical tool call, even though it now spans a parent claim and a child task.
 */
async function call(overrides: Record<string, unknown> = {}) {
  const { poll, signal, ...claimOverrides } = overrides as {
    poll?: typeof FAST_POLL;
    signal?: AbortSignal;
  } & Record<string, unknown>;

  const claim = await claimToolCall({
    runId: "run_a",
    ownerId: "user_a",
    messageId: "msg_a",
    toolName: "crop_image",
    toolCallId: "call_1",
    rawInput: CROP_INPUT,
    ...claimOverrides,
  });

  if (claim.status === "in_flight") {
    const execution = await readTerminalToolExecution(claim.invocationId);

    if (!execution) throw new Error("test child still in flight");

    return execution;
  }

  if (claim.status !== "claimed") return claim.execution;

  return runClaimedTool({
    invocationId: claim.invocationId,
    ownerId: "user_a",
    runId: "run_a",
    nodeType: claim.nodeType,
    nodeInput: claim.nodeInput,
    reserved: claim.reserved,
    signal,
    poll: poll ?? FAST_POLL,
  });
}

beforeEach(() => {
  rows.clear();
  byKey.clear();
  nextId = 0;
  vi.clearAllMocks();
  dispatchNodeRun.mockResolvedValue({ runId: "ext_1", triggerRunId: "run_1" });
  getNodeRun.mockResolvedValue(magicaRun());
});

describe("executeTool", () => {
  it("dispatches, polls to terminal and persists a typed result", async () => {
    getNodeRun
      .mockResolvedValueOnce(magicaRun({ status: "RUNNING", output: null }))
      .mockResolvedValueOnce(magicaRun());

    const execution = await call();

    expect(execution.state).toBe("COMPLETED");
    expect(execution.result).toMatchObject({
      type: "image",
      urls: ["https://x.test/out.png"],
    });
    expect(execution.creditUsed).toBe(5000);
    expect(getNodeRun).toHaveBeenCalledTimes(2);

    const row = rows.get(execution.invocationId)!;
    expect(row.state).toBe("COMPLETED");
    expect(row.externalRunId).toBe("ext_1");
    expect(row.resultUrl).toBe("https://x.test/out.png");
  });

  it("charges once for a duplicate dispatch of the same tool call", async () => {
    const first = await call();
    const second = await call();

    expect(second.invocationId).toBe(first.invocationId);
    expect(second.deduped).toBe(true);
    // The second call must never reach the provider: Magica does not dedupe.
    expect(dispatchNodeRun).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it("reports a duplicate pending child as in-flight, never failed", async () => {
    const first = await claimToolCall({
      runId: "run_a",
      ownerId: "user_a",
      messageId: "msg_a",
      toolName: "crop_image",
      toolCallId: "call_1",
      rawInput: CROP_INPUT,
    });
    const replay = await claimToolCall({
      runId: "run_a",
      ownerId: "user_a",
      messageId: "msg_a",
      toolName: "crop_image",
      toolCallId: "call_1",
      rawInput: CROP_INPUT,
    });

    expect(first.status).toBe("claimed");
    expect(replay).toMatchObject({
      status: "in_flight",
      invocationId: first.status === "claimed" ? first.invocationId : "",
    });
    expect(dispatchNodeRun).not.toHaveBeenCalled();
  });

  it("treats a different tool call in the same run as a separate execution", async () => {
    const first = await call();
    const second = await call({ toolCallId: "call_2" });

    expect(second.invocationId).not.toBe(first.invocationId);
    expect(dispatchNodeRun).toHaveBeenCalledTimes(2);
  });

  it("records a provider failure with a code and a user-safe message", async () => {
    getNodeRun.mockResolvedValue(
      magicaRun({
        status: "FAILED",
        output: null,
        error: "internal stack detail",
        userMessage: "The image could not be cropped.",
        creditUsed: 0,
      }),
    );

    const execution = await call();

    expect(execution.state).toBe("FAILED");
    expect(execution.errorCode).toBe("tool_failed");
    expect(execution.userMessage).toBe("The image could not be cropped.");
    // Internal detail must not be persisted anywhere the client can read.
    expect(JSON.stringify([...rows.values()])).not.toContain("stack detail");
  });

  it("fails the step, not the turn, when dispatch is rejected", async () => {
    dispatchNodeRun.mockRejectedValue(
      new MagicaError({
        status: 400,
        code: "BAD_REQUEST",
        message: "Invalid request.",
        userMessage: "That request wasn't valid for this tool.",
      }),
    );

    const execution = await call();

    expect(execution.state).toBe("FAILED");
    expect(execution.errorCode).toBe("BAD_REQUEST");
  });

  it("times out a run that never reaches a terminal state", async () => {
    getNodeRun.mockResolvedValue(
      magicaRun({ status: "RUNNING", output: null }),
    );

    const execution = await call({
      poll: {
        timeoutMs: 5,
        initialDelayMs: 10,
        maxDelayMs: 10,
        sleep: async () => {},
      },
    });

    expect(execution.state).toBe("FAILED");
    expect(execution.errorCode).toBe("tool_timeout");
    expect(execution.creditUsed).toBe(5_000);
    expect(settleCredits).toHaveBeenCalledWith(
      expect.objectContaining({ reserved: 5_000, actual: 5_000 }),
    );
    expect(refundReservation).not.toHaveBeenCalled();
  });

  it("stops polling when the run is cancelled", async () => {
    const controller = new AbortController();

    getNodeRun.mockImplementation(async () => {
      controller.abort(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );
      return magicaRun({ status: "RUNNING", output: null });
    });

    const execution = await call({ signal: controller.signal });

    expect(execution.state).toBe("CANCELLED");
    expect(execution.errorCode).toBe("tool_cancelled");
    expect(execution.creditUsed).toBe(5_000);
    expect(refundReservation).not.toHaveBeenCalled();
  });

  it("records an unusable provider output as a failed step", async () => {
    getNodeRun.mockResolvedValue(magicaRun({ output: { image_url: null } }));

    const execution = await call();

    expect(execution.state).toBe("FAILED");
    expect(execution.errorCode).toBe("tool_output_unusable");
  });

  it("resumes polling instead of re-dispatching after a child retry", async () => {
    // Simulates a child task that crashed after dispatching: the row already
    // carries an externalRunId, and Magica has already charged for that run.
    const claim = await claimToolCall({
      runId: "run_a",
      ownerId: "user_a",
      messageId: "msg_a",
      toolName: "crop_image",
      toolCallId: "call_1",
      rawInput: CROP_INPUT,
    });

    if (claim.status !== "claimed") throw new Error("expected a claim");

    rows.get(claim.invocationId)!.externalRunId = "ext_already_paid";

    const execution = await runClaimedTool({
      invocationId: claim.invocationId,
      ownerId: "user_a",
      runId: "run_a",
      nodeType: claim.nodeType,
      nodeInput: claim.nodeInput,
      reserved: claim.reserved,
      poll: FAST_POLL,
    });

    expect(dispatchNodeRun).not.toHaveBeenCalled();
    expect(getNodeRun).toHaveBeenCalledWith("ext_already_paid", undefined);
    expect(execution.state).toBe("COMPLETED");
  });

  it("never dispatches an unknown tool or invalid input", async () => {
    const unknown = await call({ toolName: "not_a_tool" });
    const invalid = await call({
      toolCallId: "call_bad",
      rawInput: { image_url: "not-a-url" },
    });

    expect(unknown.errorCode).toBe("unknown_tool");
    expect(invalid.errorCode).toBe("invalid_tool_input");
    expect(dispatchNodeRun).not.toHaveBeenCalled();
  });
});
