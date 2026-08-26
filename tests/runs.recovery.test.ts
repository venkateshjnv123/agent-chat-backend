import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stale-lock recovery and the retry contract (PLAN.md 3.7, 3.13).
 *
 * Both exist because of the same constraint: one active run per chat, enforced
 * by a partial unique index. That index is correct, and it is also the thing
 * that can wedge a chat forever when a worker dies without unwinding. These
 * cases pin down the recovery without weakening the guarantee it protects.
 */

type Run = {
  id: string;
  chatId: string;
  status: string;
  retryable: boolean;
  attempt: number;
  triggerRunId: string | null;
  startedAt: Date | null;
  createdAt: Date;
  ownerId: string;
};

let run: Run;
let messageStatus: string;

const agentRun = {
  findFirst: vi.fn(
    async (args?: { where?: { status?: { in?: string[] } } }) => {
      const wanted = args?.where?.status?.in;

      // The real query filters on status, and the WAITING exemption depends on
      // it: a fake that ignores the filter would pass a broken implementation.
      if (wanted && !wanted.includes(run.status)) return null;

      return { ...run, messages: [{ id: "msg_assistant" }] };
    },
  ),
  updateMany: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { status?: { in?: string[] } | string; attempt?: number };
      data: Partial<Run>;
    }) => {
      const statusOk =
        where.status === undefined ||
        (typeof where.status === "string"
          ? run.status === where.status
          : (where.status.in ?? []).includes(run.status));
      const attemptOk =
        where.attempt === undefined || run.attempt === where.attempt;

      if (!statusOk || !attemptOk) return { count: 0 };

      Object.assign(run, data);

      return { count: 1 };
    },
  ),
  update: vi.fn(async ({ data }: { data: Partial<Run> }) => {
    Object.assign(run, data);
    return run;
  }),
};

const message = {
  updateMany: vi.fn(async ({ data }: { data: { status: string } }) => {
    messageStatus = data.status;
    return { count: 1 };
  }),
  update: vi.fn(async ({ data }: { data: { status: string } }) => {
    messageStatus = data.status;
    return {};
  }),
};

vi.mock("@/db/client", () => ({ prisma: { agentRun, message } }));

const ensureRunDispatched = vi.fn(async () => ({
  triggerRunId: "trigger_2",
  realtimeToken: "tok",
  expiresAt: new Date(),
}));

vi.mock("@/services/dispatchRun", () => ({ ensureRunDispatched }));

const { reclaimStaleRun } = await import("@/services/staleRuns");
const { retryRun } = await import("@/services/retryRun");

beforeEach(() => {
  run = {
    id: "run_1",
    chatId: "chat_1",
    status: "RUNNING",
    retryable: false,
    attempt: 0,
    triggerRunId: "trigger_1",
    startedAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 60_000),
    ownerId: "user_a",
  };
  messageStatus = "STREAMING";
  vi.clearAllMocks();
});

const OWNER = { userAccountId: "user_a", runId: "run_1" };

describe("stale lock", () => {
  it("leaves a run that is still inside its lease alone", async () => {
    const outcome = await reclaimStaleRun("chat_1");

    expect(outcome).toMatchObject({ reclaimed: false });
    expect(run.status).toBe("RUNNING");
  });

  it("releases a run whose worker died and marks it retryable", async () => {
    run.startedAt = new Date(Date.now() - 40 * 60 * 1000);

    const outcome = await reclaimStaleRun("chat_1");

    expect(outcome).toMatchObject({ reclaimed: true, runId: "run_1" });
    expect(run).toMatchObject({
      status: "FAILED",
      errorCode: "run_lease_expired",
      retryable: true,
    });
    // A placeholder left PENDING renders as a message that streams forever.
    expect(messageStatus).toBe("FAILED");
  });

  it("dates the lease from acceptance when the run never started", async () => {
    run.status = "QUEUED";
    run.startedAt = null;
    run.createdAt = new Date(Date.now() - 40 * 60 * 1000);

    expect(await reclaimStaleRun("chat_1")).toMatchObject({ reclaimed: true });
  });

  it("never reclaims a run waiting on a person", async () => {
    run.status = "WAITING";
    run.startedAt = new Date(Date.now() - 40 * 60 * 1000);

    // A plan waiting for approval is doing exactly what it should, and carries
    // its own one-hour expiry.
    expect(await reclaimStaleRun("chat_1")).toMatchObject({
      reclaimed: false,
      runId: null,
    });
  });

  it("does not fail a run that came back to life mid-check", async () => {
    run.startedAt = new Date(Date.now() - 40 * 60 * 1000);
    agentRun.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await reclaimStaleRun("chat_1")).toMatchObject({
      reclaimed: false,
    });
    expect(run.status).toBe("RUNNING");
  });
});

describe("retry", () => {
  it("reuses the run and its message rather than creating new ones", async () => {
    run.status = "FAILED";
    run.retryable = true;

    const outcome = await retryRun(OWNER);

    expect(outcome).toMatchObject({
      retried: true,
      runId: "run_1",
      messageId: "msg_assistant",
      attempt: 1,
    });
    // Same run id and same assistant message: the user's original message is
    // never written twice because it is never written at all.
    expect(ensureRunDispatched).toHaveBeenCalledWith("run_1", null);
  });

  it("refuses a failure the worker did not mark retryable", async () => {
    run.status = "FAILED";
    run.retryable = false;

    expect(await retryRun(OWNER)).toMatchObject({
      retried: false,
      reason: "not_retryable",
    });
    expect(ensureRunDispatched).not.toHaveBeenCalled();
  });

  it("refuses a run that is still going", async () => {
    expect(await retryRun(OWNER)).toMatchObject({
      retried: false,
      reason: "run_active",
    });
    expect(ensureRunDispatched).not.toHaveBeenCalled();
  });

  it("lets only one of two simultaneous clicks dispatch", async () => {
    run.status = "FAILED";
    run.retryable = true;

    const [first, second] = await Promise.all([
      retryRun(OWNER),
      retryRun(OWNER),
    ]);

    expect([first?.retried, second?.retried].filter(Boolean)).toHaveLength(1);
    // Paid work must not be dispatched twice by a double click.
    expect(ensureRunDispatched).toHaveBeenCalledTimes(1);
  });

  it("hides someone else's run behind the same answer as a missing one", async () => {
    agentRun.findFirst.mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof agentRun.findFirst>>,
    );

    expect(await retryRun({ ...OWNER, userAccountId: "user_b" })).toBeNull();
  });
});
