import { z } from "zod";

import { paginated } from "./common";

/**
 * Credits are integer microcredits everywhere on the wire. The UI divides by
 * 1e6 for display: `X.XXM` for balances, `~X.XXXXM` for plan estimates.
 * See REFERENCE_FINDINGS.md §16.2.
 */
export const LedgerKindSchema = z.enum(["RESERVE", "SETTLE", "REFUND"]);

export const CreditBalanceSchema = z.object({
  /** Spendable now: balance minus outstanding reservations. */
  availableBalance: z.number().int(),
  /** Held by runs that have started but not settled. */
  reservedBalance: z.number().int().default(0),
  /** availableBalance rendered as `X.XX` — the sidebar figure. */
  formatted: z.string(),
});

export const LedgerEntrySchema = z.object({
  id: z.string(),
  /** Signed microcredits. */
  delta: z.number().int(),
  kind: LedgerKindSchema,
  toolName: z.string().nullable(),
  runId: z.string().nullable(),
  /** Links a charge to the exact tool execution that caused it. */
  toolInvocationId: z.string().nullable().default(null),
  /**
   * True for model usage, which we record at zero application credits so the
   * turn stays auditable. Machine-readable so the UI can label it without
   * pattern-matching on `note`.
   */
  zeroRated: z.boolean().default(false),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const LedgerQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Returned with a 402 when a run cannot start or cannot continue.
 * `retryable` is false when the shortfall is permanent for this turn, so the
 * frontend offers "add credits" rather than a retry that will fail again.
 */
export const InsufficientCreditsSchema = z.object({
  required: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  shortfall: z.number().int().nonnegative(),
  retryable: z.boolean(),
});

export const LedgerListResponseSchema = paginated(LedgerEntrySchema);

export type CreditBalance = z.infer<typeof CreditBalanceSchema>;
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
