import { beforeEach, describe, expect, it, vi } from "vitest";

const cancel = vi.fn(async () => ({ id: "trigger_1" }));
vi.mock("@trigger.dev/sdk", () => ({ runs: { cancel } }));

const run = {
  id: "run_1",
  status: "RUNNING",
  triggerRunId: "trigger_1" as string | null,
  dispatchingAt: null as Date | null,
  cancellationRequestedAt: null as Date | null,
};

const agentRun = {
  updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(run, data);
    return { count: 1 };
  }),
  findUnique: vi.fn(async () => ({ ...run })),
};
const message = { updateMany: vi.fn(async () => ({ count: 1 })) };
const waitpoint = { updateMany: vi.fn(async () => ({ count: 1 })) };
const prisma = {
  agentRun,
  message,
  waitpoint,
  $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
    Promise.all(operations),
  ),
};

vi.mock("@/db/client", () => ({ prisma }));
vi.mock("@/services/runs", () => ({
  findOwnedRun: vi.fn(async (ownerId: string) =>
    ownerId === "owner_1" ? { ...run } : null,
  ),
  isTerminal: (status: string) =>
    ["COMPLETED", "FAILED", "CANCELLED"].includes(status),
}));

const { requestRunCancellation } = await import("@/services/cancelRun");

beforeEach(() => {
  Object.assign(run, {
    status: "RUNNING",
    triggerRunId: "trigger_1",
    dispatchingAt: null,
    cancellationRequestedAt: null,
  });
  vi.clearAllMocks();
});

describe("run cancellation", () => {
  it("stays CANCELLING when Trigger rejects delivery", async () => {
    cancel.mockRejectedValueOnce(new Error("offline"));

    const outcome = await requestRunCancellation("owner_1", "run_1");

    expect(outcome).toMatchObject({ status: "CANCELLING", cancelled: true });
    expect(run.status).toBe("CANCELLING");
    expect(message.updateMany).not.toHaveBeenCalled();
  });

  it("becomes terminal only after Trigger accepts cancellation", async () => {
    const outcome = await requestRunCancellation("owner_1", "run_1");

    expect(outcome).toMatchObject({ status: "CANCELLED", cancelled: true });
    expect(run.status).toBe("CANCELLED");
    expect(message.updateMany).toHaveBeenCalled();
    expect(waitpoint.updateMany).toHaveBeenCalled();
  });

  it("cancels an undispatched row without calling Trigger", async () => {
    run.status = "QUEUED";
    run.triggerRunId = null;

    expect(await requestRunCancellation("owner_1", "run_1")).toMatchObject({
      status: "CANCELLED",
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("waits for a dispatch already in flight", async () => {
    run.status = "QUEUED";
    run.triggerRunId = null;
    run.dispatchingAt = new Date();

    expect(await requestRunCancellation("owner_1", "run_1")).toMatchObject({
      status: "CANCELLING",
    });
    expect(run.status).toBe("CANCELLING");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("hides a foreign run", async () => {
    expect(await requestRunCancellation("owner_2", "run_1")).toBeNull();
    expect(agentRun.updateMany).not.toHaveBeenCalled();
  });
});
