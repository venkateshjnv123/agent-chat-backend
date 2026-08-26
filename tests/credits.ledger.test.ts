import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ledger behaviour against an in-memory account.
 *
 * The fake keeps the two things the real database is relied on for: a unique
 * index on `opKey`, and a transaction that serialises writers. Without the
 * unique index a duplicate charge would pass silently; without serialisation
 * the concurrency case below would pass for the wrong reason.
 */

type Entry = {
  id: string;
  accountId: string;
  runId: string | null;
  delta: number;
  kind: "RESERVE" | "SETTLE" | "REFUND";
  opKey: string;
  toolName: string | null;
  note: string | null;
};

const account = { id: "acc_1", ownerId: "user_a", balance: 1_000_000 };
const entries: Entry[] = [];
let nextId = 0;

/** Serialises transactions, standing in for the account row lock. */
let queue: Promise<unknown> = Promise.resolve();

function uniqueViolation() {
  return Object.assign(new Error("unique constraint: opKey"), {
    code: "P2002",
  });
}

const creditLedgerEntry = {
  create: vi.fn(async ({ data }: { data: Omit<Entry, "id"> }) => {
    if (entries.some((entry) => entry.opKey === data.opKey)) {
      throw uniqueViolation();
    }

    const row: Entry = { id: `led_${++nextId}`, ...data };
    entries.push(row);

    return row;
  }),
  findUnique: vi.fn(
    async ({ where }: { where: { opKey: string } }) =>
      entries.find((entry) => entry.opKey === where.opKey) ?? null,
  ),
  findUniqueOrThrow: vi.fn(async ({ where }: { where: { opKey: string } }) => {
    const found = entries.find((entry) => entry.opKey === where.opKey);

    if (!found) throw new Error("not found");

    return found;
  }),
};

const creditAccount = {
  upsert: vi.fn(async () => account),
  update: vi.fn(
    async ({
      data,
    }: {
      data: { balance?: { increment?: number; decrement?: number } };
    }) => {
      account.balance += data.balance?.increment ?? 0;
      account.balance -= data.balance?.decrement ?? 0;

      return account;
    },
  ),
};

const prisma = {
  creditLedgerEntry,
  creditAccount,
  $queryRaw: vi.fn(async () => [{ id: account.id, balance: account.balance }]),
  $transaction: vi.fn(async (body: (tx: unknown) => Promise<unknown>) => {
    const run = queue.then(() => body(prisma));

    queue = run.catch(() => undefined);

    return run;
  }),
};

vi.mock("@/db/client", () => ({ prisma }));

const {
  estimateOrFallback,
  opKeyFor,
  recordModelUsage,
  refundReservation,
  reserveCredits,
  settleCredits,
} = await import("@/services/creditLedger");

const OWNER = { ownerId: "user_a", runId: "run_1", subject: "inv_1" };

beforeEach(() => {
  entries.length = 0;
  nextId = 0;
  account.balance = 1_000_000;
  queue = Promise.resolve();
  vi.clearAllMocks();
});

describe("reserve", () => {
  it("debits the balance and takes a row lock before deciding", async () => {
    const result = await reserveCredits({ ...OWNER, amount: 200_000 });

    expect(result).toMatchObject({ ok: true, reserved: 200_000 });
    expect(account.balance).toBe(800_000);
    // The lock, not the read that preceded it, is what authorises the spend.
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it("refuses a step the balance cannot cover and charges nothing", async () => {
    const result = await reserveCredits({ ...OWNER, amount: 1_500_000 });

    expect(result).toEqual({
      ok: false,
      required: 1_500_000,
      available: 1_000_000,
      shortfall: 500_000,
      retryable: false,
    });
    expect(account.balance).toBe(1_000_000);
    expect(entries).toHaveLength(0);
  });

  it("cannot be driven negative by concurrent reservations", async () => {
    const results = await Promise.all([
      reserveCredits({ ...OWNER, subject: "inv_1", amount: 700_000 }),
      reserveCredits({ ...OWNER, subject: "inv_2", amount: 700_000 }),
    ]);

    // One wins, one is refused. Both succeeding is the bug this guards.
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(account.balance).toBe(300_000);
  });

  it("treats a replayed reservation as already applied", async () => {
    await reserveCredits({ ...OWNER, amount: 200_000 });
    const replay = await reserveCredits({ ...OWNER, amount: 200_000 });

    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      reserved: 200_000,
    });
    expect(account.balance).toBe(800_000);
    expect(entries).toHaveLength(1);
  });
});

describe("settle", () => {
  it("returns the unused part of a generous reservation", async () => {
    await reserveCredits({ ...OWNER, amount: 200_000, toolName: "crop_image" });

    const result = await settleCredits({
      ...OWNER,
      reserved: 200_000,
      actual: 5_000,
      toolName: "crop_image",
    });

    expect(result).toMatchObject({ settled: 5_000, refunded: 195_000 });
    expect(account.balance).toBe(995_000);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "RESERVE",
      "SETTLE",
      "REFUND",
    ]);
  });

  it("charges the shortfall when the provider cost more than estimated", async () => {
    await reserveCredits({ ...OWNER, amount: 100_000 });

    await settleCredits({ ...OWNER, reserved: 100_000, actual: 130_000 });

    expect(account.balance).toBe(870_000);
    expect(entries.at(-1)).toMatchObject({ kind: "SETTLE", delta: -30_000 });
  });

  it("writes a settlement row even when the estimate was exact", async () => {
    await reserveCredits({ ...OWNER, amount: 50_000 });
    await settleCredits({ ...OWNER, reserved: 50_000, actual: 50_000 });

    expect(entries.map((entry) => entry.kind)).toEqual(["RESERVE", "SETTLE"]);
    expect(account.balance).toBe(950_000);
  });

  it("settles once however many times the child retries", async () => {
    await reserveCredits({ ...OWNER, amount: 200_000 });

    await settleCredits({ ...OWNER, reserved: 200_000, actual: 5_000 });
    const replay = await settleCredits({
      ...OWNER,
      reserved: 200_000,
      actual: 5_000,
    });

    expect(replay.replayed).toBe(true);
    expect(account.balance).toBe(995_000);
    expect(entries.filter((entry) => entry.kind === "SETTLE")).toHaveLength(1);
  });

  it("records an uncovered overrun without making balance negative", async () => {
    account.balance = 60_000;
    await reserveCredits({ ...OWNER, amount: 50_000 });

    const result = await settleCredits({
      ...OWNER,
      reserved: 50_000,
      actual: 90_000,
    });

    expect(account.balance).toBe(0);
    expect(result.uncovered).toBe(30_000);
    expect(entries.at(-1)?.note).toContain("30000 provider credits uncovered");
  });
});

describe("refund", () => {
  it("returns a whole reservation for work that never ran", async () => {
    await reserveCredits({ ...OWNER, amount: 200_000 });

    const result = await refundReservation({ ...OWNER });

    expect(result).toMatchObject({ refunded: 200_000 });
    expect(account.balance).toBe(1_000_000);
  });

  it("refuses to mint credit when nothing was reserved", async () => {
    const result = await refundReservation({ ...OWNER });

    expect(result).toEqual({ refunded: 0, replayed: false });
    expect(account.balance).toBe(1_000_000);
    expect(entries).toHaveLength(0);
  });

  it("is idempotent", async () => {
    await reserveCredits({ ...OWNER, amount: 200_000 });
    await refundReservation({ ...OWNER });
    await refundReservation({ ...OWNER });

    expect(account.balance).toBe(1_000_000);
    expect(entries.filter((entry) => entry.kind === "REFUND")).toHaveLength(1);
  });
});

describe("model usage", () => {
  it("records OpenRouter at zero application credits", async () => {
    await recordModelUsage({
      ownerId: "user_a",
      runId: "run_1",
      subject: "msg_1",
      model: "openrouter/free",
      inputTokens: 1_200,
      outputTokens: 340,
    });

    expect(account.balance).toBe(1_000_000);
    expect(entries[0]).toMatchObject({ delta: 0, toolName: null });
    expect(entries[0].note).toContain("billed at zero");
  });

  it("does not double-record when a turn is retried", async () => {
    const usage = {
      ownerId: "user_a",
      runId: "run_1",
      subject: "msg_1",
      model: "openrouter/free",
      inputTokens: 1,
      outputTokens: 1,
    };

    await recordModelUsage(usage);
    await recordModelUsage(usage);

    expect(entries).toHaveLength(1);
  });
});

describe("op keys and estimates", () => {
  it("derives a distinct key per operation on the same subject", () => {
    const parts = { runId: "run_1", subject: "inv_1" };

    expect(opKeyFor(parts, "RESERVE")).toBe("run_1:inv_1:reserve");
    expect(opKeyFor(parts, "SETTLE")).toBe("run_1:inv_1:settle");
    expect(opKeyFor(parts, "REFUND")).toBe("run_1:inv_1:refund");
  });

  it("falls back to a conservative estimate when pricing is unavailable", () => {
    expect(estimateOrFallback(4_200)).toBe(4_200);
    expect(estimateOrFallback(null)).toBeGreaterThan(0);
    expect(estimateOrFallback(Number.NaN)).toBe(estimateOrFallback(null));
    expect(estimateOrFallback(-5)).toBe(0);
  });
});
