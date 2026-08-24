/**
 * Credits are integer microcredits on the wire and in the database.
 *
 * The reference product displays them divided by a million: balances at two
 * decimals, per-step estimates at four. Formatting lives here so the unit is
 * converted in exactly one place.
 */
const MICRO_PER_CREDIT = 1_000_000;

export function formatCredits(microcredits: number, precision = 2): string {
  return (microcredits / MICRO_PER_CREDIT).toFixed(precision);
}

export function formatEstimate(microcredits: number): string {
  return `~${formatCredits(microcredits, 4)}M`;
}
