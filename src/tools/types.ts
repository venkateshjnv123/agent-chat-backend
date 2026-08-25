import type { z } from "zod";

import type { RendererKey, ToolResult } from "@/contracts/chat";

/**
 * One tool, described once.
 *
 * The agent loop consumes only this shape, so adding a tool is adding a file —
 * never a branch in orchestration. `input` is the wire contract (property keys
 * are Magica `zodExpectedName` values), `toNodeInput` maps validated input onto
 * the dispatch body, and `toResult` narrows provider output to the same
 * discriminated union the frontend renders.
 */
export type ToolDefinition<Input extends z.ZodType = z.ZodType> = {
  /** Name exposed to the model. Unique across the registry. */
  readonly name: string;
  /** Magica node type. Several tools may share one node via `subModelId`. */
  readonly nodeType: string;
  readonly subModelId: string | null;
  readonly description: string;
  /** Tells the frontend which renderer draws the card. */
  readonly rendererKey: RendererKey;
  readonly input: Input;
  /** Validated input → Magica request body. */
  toNodeInput(input: z.infer<Input>): Record<string, unknown>;
  /** Magica `output` → provider-neutral result. */
  toResult(output: Record<string, unknown>): ToolResult;
  /**
   * Fields dropped before the input is persisted or shown.
   *
   * Nothing here is secret today; the hook exists so a tool that later accepts
   * a signed upload token cannot leak it into `sanitizedInput`.
   */
  readonly redactedFields?: readonly string[];
};

/** Raised when provider output does not carry what the renderer needs. */
export class ToolOutputError extends Error {
  readonly code = "tool_output_unusable";
  readonly userMessage = "The tool finished but returned nothing usable.";

  constructor(toolName: string, detail: string) {
    super(`${toolName}: ${detail}`);
    this.name = "ToolOutputError";
  }
}

/** Reads a URL list from provider output, accepting the single-value form. */
export function urlList(
  toolName: string,
  output: Record<string, unknown>,
  field: string,
): string[] {
  const value = output[field];
  const urls = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );

  if (urls.length === 0) {
    throw new ToolOutputError(toolName, `output.${field} carried no URL`);
  }

  return urls;
}

export function optionalInt(
  output: Record<string, unknown>,
  field: string,
): number | null {
  const value = output[field];

  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}
