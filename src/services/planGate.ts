import { getTool } from "@/tools/registry";

/**
 * Decides when a batch of tool calls has to be shown to the user first.
 *
 * The rule is that credits are never spent on a call the user has not seen.
 * That is stricter than approving once per run: a chained task discovers the
 * arguments for its later steps only after the earlier step produced them, so
 * those calls were not on the card that was approved and cannot inherit its
 * approval. Turns that only read local guidance cost nothing and are never
 * interrupted, which is how the reference product behaves — the card appears
 * for billable work and for nothing else.
 */

export interface GateCall {
  name: string;
  input: unknown;
}

/**
 * Identifies a call by what it would actually do.
 *
 * Keys are sorted so two calls differing only in property order compare equal,
 * and the arguments are part of the identity because the arguments are what the
 * price was quoted for.
 */
export function callFingerprint(call: GateCall): string {
  return `${call.name}:${stableStringify(call.input)}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

  return `{${entries.join(",")}}`;
}

/**
 * True when at least one call in the batch would spend credits and has not
 * already been approved with these exact arguments.
 */
export function needsPlanApproval(
  toolCalls: readonly GateCall[],
  approvedCalls: ReadonlySet<string>,
): boolean {
  return toolCalls.some(
    (call) =>
      getTool(call.name) !== undefined &&
      !approvedCalls.has(callFingerprint(call)),
  );
}
