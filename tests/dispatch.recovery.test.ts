import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchAgentTurn = vi.fn(async () => ({
  triggerRunId: "trigger_1",
  realtimeToken: "token_1",
  expiresAt: new Date("2026-08-26T12:00:00Z"),
}));
const mintRealtimeToken = vi.fn(async (triggerRunId: string) => ({
  realtimeToken: `token_for_${triggerRunId}`,
  expiresAt: new Date("2026-08-26T12:00:00Z"),
}));

vi.mock("@/agent/dispatch", () => ({
  dispatchAgentTurn,
  mintRealtimeToken,
}));

const run = {
  id: "run_1",
  chatId: "chat_1",
  ownerId: "owner_1",
  status: "QUEUED",
  triggerRunId: null as string | null,
  traceId: "trace_1",
  planMode: true,
  attempt: 0,
  messages: [{ id: "message_1" }],
};

const agentRun = {
  findUnique: vi.fn(async () => ({ ...run })),
  updateMany: vi.fn(async () => {
    run.triggerRunId = "trigger_1";
    return { count: 1 };
  }),
};

vi.mock("@/db/client", () => ({ prisma: { agentRun } }));

const { ensureRunDispatched } = await import("@/services/dispatchRun");

beforeEach(() => {
  run.status = "QUEUED";
  run.triggerRunId = null;
  vi.clearAllMocks();
});

describe("accepted-run outbox", () => {
  it("rebuilds a missing dispatch entirely from durable state", async () => {
    const outcome = await ensureRunDispatched("run_1", "session_1");

    expect(dispatchAgentTurn).toHaveBeenCalledWith({
      chatId: "chat_1",
      runId: "run_1",
      assistantMessageId: "message_1",
      userAccountId: "owner_1",
      traceId: "trace_1",
      sessionId: "session_1",
      planMode: true,
      attempt: 0,
    });
    expect(run.triggerRunId).toBe("trigger_1");
    expect(outcome?.realtimeToken).toBe("token_1");
  });

  it("does not enqueue again after the handle is stored", async () => {
    run.triggerRunId = "trigger_existing";

    const outcome = await ensureRunDispatched("run_1");

    expect(dispatchAgentTurn).not.toHaveBeenCalled();
    expect(mintRealtimeToken).toHaveBeenCalledWith("trigger_existing");
    expect(outcome?.triggerRunId).toBe("trigger_existing");
  });

  it("does not resurrect a terminal undispatched run", async () => {
    run.status = "CANCELLED";

    expect(await ensureRunDispatched("run_1")).toBeNull();
    expect(dispatchAgentTurn).not.toHaveBeenCalled();
  });
});
