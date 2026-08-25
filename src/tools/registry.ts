import { z } from "zod";

import { cropImage } from "@/tools/definitions/crop-image";
import { gptImage2Edit, gptImage2Text } from "@/tools/definitions/gpt-image-2";
import { mergeVideos } from "@/tools/definitions/merge-videos";
import type { ToolDefinition } from "@/tools/types";

/**
 * The whole tool surface, in one list.
 *
 * The agent loop reads only from here: it asks for the JSON schemas, then looks
 * a call back up by name. Nothing downstream knows which tools exist, so adding
 * a tool is adding a file and one line to this array.
 */
const DEFINITIONS: readonly ToolDefinition[] = [
  cropImage,
  gptImage2Text,
  gptImage2Edit,
  mergeVideos,
];

const BY_NAME = new Map(
  DEFINITIONS.map((definition) => [definition.name, definition]),
);

// A duplicate name would silently shadow a tool, so it fails at import.
if (BY_NAME.size !== DEFINITIONS.length) {
  throw new Error("Duplicate tool name in registry");
}

export function listTools(): readonly ToolDefinition[] {
  return DEFINITIONS;
}

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

export type OpenRouterTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Renders the registry as OpenRouter tool JSON.
 *
 * `io: "input"` makes defaulted fields optional in the schema, which is what
 * the model should see: it may omit them, and Zod fills them in on the way to
 * the provider. Unrepresentable values are stringified rather than thrown so a
 * single awkward field cannot take down the whole turn.
 */
export function toOpenRouterTools(
  definitions: readonly ToolDefinition[] = DEFINITIONS,
): OpenRouterTool[] {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: z.toJSONSchema(definition.input, {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>,
    },
  }));
}

/**
 * Drops fields a tool marks as unsafe to persist.
 *
 * Applied before the input reaches `ToolInvocation.sanitizedInput`, which is
 * read back by the frontend.
 */
export function sanitizeInput(
  definition: ToolDefinition,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = new Set(definition.redactedFields ?? []);

  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !redacted.has(key)),
  );
}
