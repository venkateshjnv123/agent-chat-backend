import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
vi.mock("@trigger.dev/sdk", () => ({ runs: { retrieve } }));

type Run = {
  id: string;
  status: string;
  triggerRunId: string | null;
  updatedAt: Date;
  completedAt?: Date;
  retryable?: boolean;
  errorCode?: string;
  userMessage?: string;
};

let run: Run;
let messageStatus: string;
let waitpointStatus: string;

const agentRun = {
  updateMany: vi.fn(async ({ where, data }) => {
    const statusOk =
      !where.status ||
      (where.status.in as string[] | undefined)?.includes(run.status);
    const triggerOk =
      !where.triggerRunId || where.triggerRunId === run.triggerRunId;
    const updatedOk =
      !where.updatedAt ||
      (where.updatedAt as Date).getTime() === run.updatedAt.getTime();

    if (!statusOk || !triggerOk || !updatedOk) return { count: 0 };

    Object.assign(run, data);
    return { count: 1 };
  }),
  findUnique: vi.fn(async () => ({ ...run })),
};

const message = {
  updateMany: vi.fn(async ({ data }) => {
    messageStatus = data.status;
    return { count: 1 };
  }),
};
const waitpoint = {
  updateMany: vi.fn(async ({ data }) => {
    waitpointStatus = data.status;
    return { count: 1 };
  }),
};
const prisma = {
  agentRun,
  message,
  waitpoint,
  $transaction: vi.fn(async (callback) => callback(prisma)),
};

vi.mock("@/db/client", () => ({ prisma }));

const finalizeCancelledRun = vi.fn(async () => {
  run.status = "CANCELLED";
});
vi.mock("@/services/cancelRun", () => ({ finalizeCancelledRun }));

const { reconcileTriggerTerminalState } =
  await import("@/services/triggerRunReconciliation");

beforeEach(() => {
  run = {
    id: "run_1",
    status: "QUEUED",
    triggerRunId: "trigger_1",
    updatedAt: new Date("2026-08-26T00:00:00.000Z"),
  };
  messageStatus = "PENDING";
  waitpointStatus = "PENDING";
  vi.clearAllMocks();
});

describe("Trigger terminal reconciliation", () => {
  it("does not probe a run inside the distributed probe interval", async () => {
    const now = new Date(run.updatedAt.getTime() + 10_000);

    expect(await reconcileTriggerTerminalState(run, now)).toEqual(run);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("leaves an executing Trigger run active and renews the probe lease", async () => {
    retrieve.mockResolvedValueOnce({ status: "EXECUTING" });
    const now = new Date(run.updatedAt.getTime() + 20_000);

    const result = await reconcileTriggerTerminalState(run, now);

    expect(result.status).toBe("QUEUED");
    expect(result.updatedAt).toEqual(now);
    expect(messageStatus).toBe("PENDING");
  });

  it("fails durable rows when Trigger failed before task code could persist", async () => {
    retrieve.mockResolvedValueOnce({ status: "FAILED" });
    const now = new Date(run.updatedAt.getTime() + 20_000);

    const result = await reconcileTriggerTerminalState(run, now);

    expect(result).toMatchObject({
      status: "FAILED",
      retryable: true,
      errorCode: "trigger_failed",
      completedAt: now,
    });
    expect(messageStatus).toBe("FAILED");
    expect(waitpointStatus).toBe("CANCELLED");
  });

  it("lets cancellation intent win over a terminal Trigger failure", async () => {
    run.status = "CANCELLING";
    retrieve.mockResolvedValueOnce({ status: "FAILED" });

    const result = await reconcileTriggerTerminalState(
      run,
      new Date(run.updatedAt.getTime() + 20_000),
    );

    expect(finalizeCancelledRun).toHaveBeenCalledWith(
      "run_1",
      expect.any(Date),
    );
    expect(result.status).toBe("CANCELLED");
  });
});
