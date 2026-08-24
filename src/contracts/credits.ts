import { z } from "zod";

import { paginated } from "./common";

/**
 * Credits are integer microcredits everywhere on the wire. The UI divides by
 * 1e6 for display: `X.XXM` for balances, `~X.XXXXM` for plan estimates.
 * See REFERENCE_FINDINGS.md §16.2.
 */
export const LedgerKindSchema = z.enum(["RESERVE", "SETTLE", "REFUND"]);

export const CreditBalanceSchema = z.object({
  availableBalance: z.number().int(),
  formatted: z.string(),
});

export const LedgerEntrySchema = z.object({
  id: z.string(),
  delta: z.number().int(),
  kind: LedgerKindSchema,
  toolName: z.string().nullable(),
  runId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const LedgerListResponseSchema = paginated(LedgerEntrySchema);

export type CreditBalance = z.infer<typeof CreditBalanceSchema>;
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
