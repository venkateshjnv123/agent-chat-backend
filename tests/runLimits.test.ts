import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ACTIVE_RUNS_PER_USER,
  MAX_NEW_RUNS_PER_MINUTE,
  enforceUserRunLimits,
} from "@/services/runLimits";

const queryRaw = vi.fn(async () => [{ pg_advisory_xact_lock: null }]);
const count = vi.fn();
const tx = {
  $queryRaw: queryRaw,
  agentRun: { count },
} as never;

beforeEach(() => vi.clearAllMocks());

describe("per-user run limits", () => {
  it("takes a cross-instance owner lock before counting", async () => {
    count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    await expect(enforceUserRunLimits(tx, "owner_1")).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      count.mock.invocationCallOrder[0],
    );
  });

  it("refuses excess concurrent runs", async () => {
    count.mockResolvedValueOnce(MAX_ACTIVE_RUNS_PER_USER);

    await expect(enforceUserRunLimits(tx, "owner_1")).rejects.toMatchObject({
      reason: "concurrency",
    });
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("refuses a burst even when prior runs already finished", async () => {
    count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(MAX_NEW_RUNS_PER_MINUTE);

    await expect(enforceUserRunLimits(tx, "owner_1")).rejects.toMatchObject({
      reason: "rate",
    });
  });
});
