import { prisma } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Credit accounting: reserve before spending, settle once the real cost is
 * known, refund the difference.
 *
 * Two properties drive the design.
 *
 * First, the balance must never be able to go negative under concurrency. Two
 * runs reading a balance of 1.0M and each deciding they can afford 0.8M is the
 * classic failure, so every mutation takes a row lock on the account with
 * `SELECT … FOR UPDATE` and re-reads inside the transaction. The lock, not the
 * read that preceded it, is what authorises the spend.
 *
 * Second, every step must be safe to retry. Trigger.dev will re-run a task, a
 * batch can be redelivered, and a network failure can hide a commit that
 * happened. Each entry therefore carries a unique `opKey` derived from the
 * thing being paid for; a replayed call collides on the index and is reported
 * as already-applied rather than charged twice.
 *
 * The ledger is append-only. `CreditAccount.balance` is a cached projection of
 * the sum of deltas, kept in step inside the same transaction, so a balance can
 * always be re-derived from history if the two ever disagree.
 */

/** Charged at reserve time when the provider will not price a step for us. */
const FALLBACK_ESTIMATE = 250_000;

export type LedgerKind = "RESERVE" | "SETTLE" | "REFUND";

export type ReserveResult =
  | { ok: true; reserved: number; entryId: string; replayed: boolean }
  | {
      ok: false;
      required: number;
      available: number;
      shortfall: number;
      retryable: boolean;
    };

type OpKeyParts = {
  runId: string;
  /** The thing being paid for — a tool invocation id, or a model call id. */
  subject: string;
};

/** Stable, human-readable, and unique per logical operation. */
export function opKeyFor(parts: OpKeyParts, kind: LedgerKind): string {
  return `${parts.runId}:${parts.subject}:${kind.toLowerCase()}`;
}

export async function ensureAccount(ownerId: string): Promise<string> {
  const account = await prisma.creditAccount.upsert({
    where: { ownerId },
    update: {},
    create: { ownerId },
    select: { id: true },
  });

  return account.id;
}

/**
 * Locks the account row and hands the caller a consistent balance.
 *
 * Prisma has no first-class row lock, so the lock is raw SQL issued as the
 * first statement of the transaction. Every writer below goes through here,
 * which is what makes them serialise against each other.
 */
async function withLockedAccount<T>(
  ownerId: string,
  body: (
    tx: Prisma.TransactionClient,
    account: { id: string; balance: number },
  ) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; balance: number }[]>`
      SELECT "id", "balance" FROM "CreditAccount"
      WHERE "ownerId" = ${ownerId}
      FOR UPDATE
    `;

    const account = rows[0];

    if (!account) throw new Error("credit_account_missing");

    return body(tx, account);
  });
}

/** A unique-constraint violation on `opKey` — the operation already happened. */
function isReplay(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/**
 * Holds credit for work that is about to be dispatched.
 *
 * The debit lands now rather than at settlement. Reserving optimistically and
 * charging later would let a user start more work than they can pay for, and
 * the provider bills us at dispatch, so the money is genuinely committed at
 * this point.
 */
export async function reserveCredits(options: {
  ownerId: string;
  runId: string;
  subject: string;
  amount: number;
  toolName?: string | null;
  note?: string | null;
}): Promise<ReserveResult> {
  const amount = Math.max(0, Math.trunc(options.amount));
  const opKey = opKeyFor(options, "RESERVE");

  await ensureAccount(options.ownerId);

  try {
    return await withLockedAccount(options.ownerId, async (tx, account) => {
      const existing = await tx.creditLedgerEntry.findUnique({
        where: { opKey },
        select: { id: true, delta: true },
      });

      if (existing) {
        return {
          ok: true as const,
          reserved: -existing.delta,
          entryId: existing.id,
          replayed: true,
        };
      }

      if (account.balance < amount) {
        return {
          ok: false as const,
          required: amount,
          available: account.balance,
          shortfall: amount - account.balance,
          // Nothing about waiting makes this succeed; the user has to top up.
          retryable: false,
        };
      }

      const entry = await tx.creditLedgerEntry.create({
        data: {
          accountId: account.id,
          runId: options.runId,
          toolInvocationId: options.toolName ? options.subject : null,
          delta: -amount,
          kind: "RESERVE",
          opKey,
          toolName: options.toolName ?? null,
          note: options.note ?? null,
        },
        select: { id: true },
      });

      await tx.creditAccount.update({
        where: { id: account.id },
        data: { balance: { decrement: amount } },
      });

      return {
        ok: true as const,
        reserved: amount,
        entryId: entry.id,
        replayed: false,
      };
    });
  } catch (error) {
    if (!isReplay(error)) throw error;

    // Lost the race against a concurrent replay of the same operation. The
    // other writer committed the identical reservation, so this one succeeded.
    const entry = await prisma.creditLedgerEntry.findUniqueOrThrow({
      where: { opKey },
      select: { id: true, delta: true },
    });

    return {
      ok: true,
      reserved: -entry.delta,
      entryId: entry.id,
      replayed: true,
    };
  }
}

/**
 * Closes out a reservation against what the provider actually charged.
 *
 * A SETTLE row is always written, even when the correction is zero, so every
 * reservation has a visible terminal entry and the ledger reads as a story
 * rather than a set of unexplained debits. When the estimate was too generous
 * the difference comes back as a separate REFUND row; when it was too mean the
 * shortfall is charged on the SETTLE row itself.
 *
 * A provider overrun is collected only up to the remaining balance. The real
 * provider cost remains on ToolInvocation and the uncovered amount is named in
 * the settlement note, while the spendable account never becomes negative.
 */
export async function settleCredits(options: {
  ownerId: string;
  runId: string;
  subject: string;
  reserved: number;
  actual: number;
  toolName?: string | null;
  note?: string | null;
}): Promise<{
  settled: number;
  refunded: number;
  uncovered: number;
  replayed: boolean;
}> {
  const reserved = Math.max(0, Math.trunc(options.reserved));
  const actual = Math.max(0, Math.trunc(options.actual));
  const settleKey = opKeyFor(options, "SETTLE");
  const refundKey = opKeyFor(options, "REFUND");

  try {
    return await withLockedAccount(options.ownerId, async (tx, account) => {
      const already = await tx.creditLedgerEntry.findUnique({
        where: { opKey: settleKey },
        select: { id: true },
      });

      if (already) {
        return { settled: actual, refunded: 0, uncovered: 0, replayed: true };
      }

      // Negative when the provider undercharged relative to the reservation.
      const correction = actual - reserved;
      const collected =
        correction > 0 ? Math.min(correction, Math.max(0, account.balance)) : 0;
      const uncovered = correction > 0 ? correction - collected : 0;
      const baseNote =
        options.note ?? `charged ${actual} against a ${reserved} reservation`;

      await tx.creditLedgerEntry.create({
        data: {
          accountId: account.id,
          runId: options.runId,
          toolInvocationId: options.toolName ? options.subject : null,
          delta: -collected,
          kind: "SETTLE",
          opKey: settleKey,
          toolName: options.toolName ?? null,
          note:
            uncovered > 0
              ? `${baseNote}; ${uncovered} provider credits uncovered`
              : baseNote,
        },
      });

      if (collected > 0) {
        await tx.creditAccount.update({
          where: { id: account.id },
          data: { balance: { decrement: collected } },
        });
      }

      if (correction < 0) {
        await tx.creditLedgerEntry.create({
          data: {
            accountId: account.id,
            runId: options.runId,
            toolInvocationId: options.toolName ? options.subject : null,
            delta: -correction,
            kind: "REFUND",
            opKey: refundKey,
            toolName: options.toolName ?? null,
            note: "unused reservation returned",
          },
        });

        await tx.creditAccount.update({
          where: { id: account.id },
          data: { balance: { increment: -correction } },
        });
      }

      return {
        settled: actual,
        refunded: correction < 0 ? -correction : 0,
        uncovered,
        replayed: false,
      };
    });
  } catch (error) {
    if (!isReplay(error)) throw error;

    return { settled: actual, refunded: 0, uncovered: 0, replayed: true };
  }
}

/**
 * Returns a whole reservation because the work never happened.
 *
 * Distinct from a settlement of zero: nothing was charged, so there is no
 * SETTLE row to explain. Used when a claimed tool fails before dispatch or a
 * run is cancelled while credit is still held.
 */
export async function refundReservation(options: {
  ownerId: string;
  runId: string;
  subject: string;
  toolName?: string | null;
  note?: string | null;
}): Promise<{ refunded: number; replayed: boolean }> {
  const reserveKey = opKeyFor(options, "RESERVE");
  const refundKey = opKeyFor(options, "REFUND");

  try {
    return await withLockedAccount(options.ownerId, async (tx, account) => {
      const reservation = await tx.creditLedgerEntry.findUnique({
        where: { opKey: reserveKey },
        select: { delta: true },
      });

      // Nothing was ever held. Refunding here would mint credit.
      if (!reservation) return { refunded: 0, replayed: false };

      const already = await tx.creditLedgerEntry.findUnique({
        where: { opKey: refundKey },
        select: { id: true },
      });

      if (already) return { refunded: -reservation.delta, replayed: true };

      const amount = -reservation.delta;

      await tx.creditLedgerEntry.create({
        data: {
          accountId: account.id,
          runId: options.runId,
          toolInvocationId: options.toolName ? options.subject : null,
          delta: amount,
          kind: "REFUND",
          opKey: refundKey,
          toolName: options.toolName ?? null,
          note: options.note ?? "step did not run",
        },
      });

      await tx.creditAccount.update({
        where: { id: account.id },
        data: { balance: { increment: amount } },
      });

      return { refunded: amount, replayed: false };
    });
  } catch (error) {
    if (!isReplay(error)) throw error;

    return { refunded: 0, replayed: true };
  }
}

/**
 * Records model usage at zero application credits.
 *
 * OpenRouter Free costs us nothing, but a turn with no ledger entry looks like
 * a turn that did no work. A zero-delta row keeps the run auditable end to end
 * and gives the credits view something honest to show for the model step. The
 * reference product bills for this; not billing is our decision, and the row
 * is where that decision is visible.
 */
export async function recordModelUsage(options: {
  ownerId: string;
  runId: string;
  subject: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const accountId = await ensureAccount(options.ownerId);

  try {
    await prisma.creditLedgerEntry.create({
      data: {
        accountId,
        runId: options.runId,
        toolInvocationId: null,
        delta: 0,
        kind: "SETTLE",
        opKey: opKeyFor(options, "SETTLE"),
        toolName: null,
        note: `${options.model}: ${options.inputTokens} in / ${options.outputTokens} out, billed at zero`,
      },
    });
  } catch (error) {
    if (!isReplay(error)) throw error;
  }
}

/**
 * What a step should cost, from the provider's own estimate.
 *
 * A failed estimate must not block the run: the provider is authoritative about
 * price but we still have to reserve something, so a conservative fallback is
 * used and settlement corrects it either way.
 */
export function estimateOrFallback(microcredits: number | null): number {
  return typeof microcredits === "number" && Number.isFinite(microcredits)
    ? Math.max(0, Math.trunc(microcredits))
    : FALLBACK_ESTIMATE;
}

/**
 * Credit currently held by reservations that have not settled.
 *
 * Derived from the ledger rather than tracked in a column: a reservation is
 * outstanding exactly when its RESERVE row has no matching SETTLE or REFUND,
 * which the opKey suffix makes a single join.
 */
export async function outstandingReservations(
  accountId: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ held: bigint | null }[]>`
    SELECT COALESCE(SUM(-r."delta"), 0)::bigint AS held
    FROM "CreditLedgerEntry" r
    WHERE r."accountId" = ${accountId}
      AND r."kind" = 'RESERVE'
      AND NOT EXISTS (
        SELECT 1 FROM "CreditLedgerEntry" c
        WHERE c."accountId" = r."accountId"
          AND c."kind" IN ('SETTLE', 'REFUND')
          AND c."opKey" IN (
            regexp_replace(r."opKey", ':reserve$', ':settle'),
            regexp_replace(r."opKey", ':reserve$', ':refund')
          )
      )
  `;

  return Number(rows[0]?.held ?? 0);
}
