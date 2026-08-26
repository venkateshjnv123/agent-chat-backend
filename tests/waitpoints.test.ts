import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plan approval, with Trigger's token store faked.
 *
 * The cases that matter are the ones a user creates by accident: pressing the
 * button twice, leaving the tab open past the deadline, and opening a link that
 * belongs to somebody else. Each has to answer without erroring and without
 * releasing the run twice.
 */

type Row = {
  id: string;
  runId: string;
  status: "PENDING" | "RESOLVED" | "EXPIRED" | "CANCELLED";
  token: string;
  resolution: string | null;
  feedback: string | null;
  resolutionKey: string | null;
  deliveryClaimedAt: Date | null;
  deliveryAttempts: number;
  deliveredAt: Date | null;
  resolvedAt: Date | null;
  expiresAt: Date;
  ownerId: string;
};

let row: Row;

const completeToken = vi.fn(async () => ({ id: "tok_1" }));

vi.mock("@trigger.dev/sdk", () => ({
  wait: {
    createToken: vi.fn(async () => ({ id: "tok_1" })),
    completeToken,
  },
}));

function view() {
  return {
    ...row,
    run: { chat: { userId: row.ownerId } },
  };
}

const waitpoint = {
  create: vi.fn(async () => ({ id: row.id })),
  findUnique: vi.fn(async () => view()),
  findUniqueOrThrow: vi.fn(async () => view()),
  update: vi.fn(async ({ data }: { data: Partial<Row> }) => {
    Object.assign(row, data);
    return row;
  }),
  updateMany: vi.fn(
    async ({
      where,
      data,
    }: {
      where: {
        status?: string;
        resolution?: string;
        resolutionKey?: string | null;
        deliveryClaimedAt?: Date | null;
        OR?: Array<{
          deliveryClaimedAt?: null | { lt: Date };
        }>;
      };
      data: Omit<Partial<Row>, "deliveryAttempts"> & {
        deliveryAttempts?: number | { increment: number };
      };
    }) => {
      if (where.status && row.status !== where.status) return { count: 0 };
      if (
        where.resolution !== undefined &&
        row.resolution !== where.resolution
      ) {
        return { count: 0 };
      }
      if (
        where.resolutionKey !== undefined &&
        row.resolutionKey !== where.resolutionKey
      ) {
        return { count: 0 };
      }
      if (
        where.deliveryClaimedAt !== undefined &&
        row.deliveryClaimedAt?.getTime() !== where.deliveryClaimedAt?.getTime()
      ) {
        return { count: 0 };
      }
      if (where.OR) {
        const matchesLease = where.OR.some((condition) => {
          if (condition.deliveryClaimedAt === null) {
            return row.deliveryClaimedAt === null;
          }

          return condition.deliveryClaimedAt?.lt
            ? !!row.deliveryClaimedAt &&
                row.deliveryClaimedAt < condition.deliveryClaimedAt.lt
            : false;
        });

        if (!matchesLease) return { count: 0 };
      }

      const { deliveryAttempts, ...rest } = data;
      Object.assign(row, rest);

      if (typeof deliveryAttempts === "number") {
        row.deliveryAttempts = deliveryAttempts;
      } else if (deliveryAttempts) {
        row.deliveryAttempts += deliveryAttempts.increment;
      }

      return { count: 1 };
    },
  ),
};

vi.mock("@/db/client", () => ({ prisma: { waitpoint } }));

const { WaitpointError, resolvePlanWaitpoint } =
  await import("@/services/waitpoints");

beforeEach(() => {
  row = {
    id: "wp_1",
    runId: "run_1",
    status: "PENDING",
    token: "tok_1",
    resolution: null,
    feedback: null,
    resolutionKey: null,
    deliveryClaimedAt: null,
    deliveryAttempts: 0,
    deliveredAt: null,
    resolvedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ownerId: "user_a",
  };
  vi.clearAllMocks();
});

const APPROVE = {
  waitpointId: "wp_1",
  userAccountId: "user_a",
  resolution: "RUN_ALL" as const,
  idempotencyKey: "decision-key-1",
};

describe("resolving a plan", () => {
  it("records the decision and releases the run", async () => {
    const outcome = await resolvePlanWaitpoint(APPROVE);

    expect(outcome).toMatchObject({
      status: "RESOLVED",
      resolution: "RUN_ALL",
      applied: true,
    });
    expect(completeToken).toHaveBeenCalledWith("tok_1", {
      resolution: "RUN_ALL",
      feedback: null,
    });
  });

  it("passes feedback through on a change request", async () => {
    await resolvePlanWaitpoint({
      ...APPROVE,
      resolution: "REQUEST_CHANGES",
      feedback: "use a smaller size",
    });

    expect(completeToken).toHaveBeenCalledWith("tok_1", {
      resolution: "REQUEST_CHANGES",
      feedback: "use a smaller size",
    });
  });

  it("refuses a resolution the plan does not offer", async () => {
    // STEP_BY_STEP is contract-valid but unimplemented, so it is not offered
    // and must not be accepted through a hand-built request.
    await expect(
      resolvePlanWaitpoint({ ...APPROVE, resolution: "STEP_BY_STEP" }),
    ).rejects.toBeInstanceOf(WaitpointError);
    expect(completeToken).not.toHaveBeenCalled();
  });
});

describe("duplicate submission", () => {
  it("reports the existing state instead of resolving twice", async () => {
    await resolvePlanWaitpoint(APPROVE);
    const second = await resolvePlanWaitpoint(APPROVE);

    expect(second).toMatchObject({
      status: "RESOLVED",
      resolution: "RUN_ALL",
      applied: false,
    });
    // Releasing the run a second time is the failure this guards against.
    expect(completeToken).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two simultaneous clicks through", async () => {
    const [first, second] = await Promise.all([
      resolvePlanWaitpoint(APPROVE),
      resolvePlanWaitpoint(APPROVE),
    ]);

    expect([first.applied, second.applied].filter(Boolean)).toHaveLength(1);
    expect(completeToken).toHaveBeenCalledTimes(1);
  });

  it("retries token delivery with the persisted client key", async () => {
    completeToken.mockRejectedValueOnce(new Error("transport down"));

    await expect(resolvePlanWaitpoint(APPROVE)).rejects.toThrow(
      "transport down",
    );
    expect(row).toMatchObject({
      status: "PENDING",
      resolution: "RUN_ALL",
      resolutionKey: "decision-key-1",
      deliveryClaimedAt: null,
    });

    expect(await resolvePlanWaitpoint(APPROVE)).toMatchObject({
      status: "RESOLVED",
      applied: true,
    });
    expect(completeToken).toHaveBeenCalledTimes(2);
  });

  it("rejects a different decision while delivery is pending", async () => {
    row.resolution = "RUN_ALL";
    row.resolutionKey = "decision-key-1";

    await expect(
      resolvePlanWaitpoint({
        ...APPROVE,
        resolution: "REQUEST_CHANGES",
        feedback: "make it blue",
        idempotencyKey: "decision-key-2",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("expiry", () => {
  it("is terminal and cannot be submitted", async () => {
    row.expiresAt = new Date(Date.now() - 1_000);

    const outcome = await resolvePlanWaitpoint(APPROVE);

    expect(outcome).toMatchObject({ status: "EXPIRED", applied: false });
    expect(row.status).toBe("EXPIRED");
    expect(completeToken).not.toHaveBeenCalled();
  });

  it("stays expired when submitted again", async () => {
    row.status = "EXPIRED";

    const outcome = await resolvePlanWaitpoint(APPROVE);

    expect(outcome).toMatchObject({ status: "EXPIRED", applied: false });
    expect(completeToken).not.toHaveBeenCalled();
  });
});

describe("ownership", () => {
  it("hides someone else's plan behind the same answer as a missing one", async () => {
    await expect(
      resolvePlanWaitpoint({ ...APPROVE, userAccountId: "user_b" }),
    ).rejects.toMatchObject({ code: "waitpoint_forbidden", status: 404 });

    expect(row.status).toBe("PENDING");
    expect(completeToken).not.toHaveBeenCalled();
  });

  it("reports a missing waitpoint as not found", async () => {
    waitpoint.findUnique.mockResolvedValueOnce(
      null as unknown as ReturnType<typeof view>,
    );

    await expect(resolvePlanWaitpoint(APPROVE)).rejects.toMatchObject({
      code: "waitpoint_not_found",
    });
  });
});
