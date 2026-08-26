import { z } from "zod";

import { ToolResultSchema, ToolStateSchema } from "./chat";

/**
 * The realtime channel contract.
 *
 * Two channels carry a running turn, and they are deliberately separate. Run
 * metadata carries status and coarse progress; the text stream carries the
 * assistant's words. A client that renders text has no reason to re-read
 * metadata for every token, and a slow reader of one channel cannot stall the
 * other. Neither is authoritative — the persisted message is, and the client
 * reconciles against it on every terminal transition.
 */

/** Stream key registered by the agent turn and subscribed to by the client. */
export const ASSISTANT_TEXT_STREAM = "assistantText";

/**
 * One delta of assistant output.
 *
 * Deltas are incremental: the client appends rather than replaces, so the wire
 * carries a token rather than the whole message so far. Missed deltas are
 * repaired by the durable message, never by replaying the stream.
 */
export const AssistantTextDeltaSchema = z.object({
  runId: z.string(),
  messageId: z.string(),
  /** Monotonic within one assistant message; reconnect duplicates are ignored. */
  sequence: z.number().int().positive(),
  /** Which model call inside the turn produced this text. */
  turn: z.number().int().min(1),
  text: z.string(),
});

export const ASSISTANT_ACTIVITY_STREAM = "assistantActivity";

const ActivityBaseSchema = z.object({
  runId: z.string(),
  messageId: z.string(),
  sequence: z.number().int().positive(),
});

/** Real worker lifecycle events; frontend never invents activity rows. */
export const AgentActivityEventSchema = z.discriminatedUnion("type", [
  ActivityBaseSchema.extend({
    type: z.literal("thinking"),
    text: z.string().min(1),
    elapsedMs: z.number().int().nonnegative(),
  }),
  ActivityBaseSchema.extend({
    type: z.literal("progress"),
    stage: z.enum([
      "planning",
      "thinking",
      "responding",
      "awaiting_approval",
      "running_tools",
      "finalizing",
    ]),
    currentStep: z.string().nullable(),
    progress: z.number().min(0).max(1),
  }),
  ActivityBaseSchema.extend({
    type: z.literal("tool"),
    toolCallId: z.string(),
    toolName: z.string(),
    state: ToolStateSchema,
    result: ToolResultSchema.nullable(),
  }),
  ActivityBaseSchema.extend({
    type: z.literal("asset"),
    toolCallId: z.string(),
    assetType: z.enum(["image", "video", "audio"]),
    url: z.url(),
  }),
]);

/** Coarse run status, mirrored on run metadata for clients that only poll. */
export const RunMetadataSchema = z.object({
  status: z
    .enum([
      "running",
      "running_tools",
      "awaiting_approval",
      "completed",
      "cancelled",
      "failed",
    ])
    .optional(),
  /** Monotonic character count, so a metadata-only client can show progress. */
  streamedCharacters: z.number().int().min(0).optional(),
  runId: z.string().optional(),
  messageId: z.string().optional(),
  currentStep: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  thinkingDurationSeconds: z.number().nonnegative().optional(),
  /** Set while a plan card is open, so a reloaded tab can fetch it. */
  waitpointId: z.string().optional(),
});

export type AssistantTextDelta = z.infer<typeof AssistantTextDeltaSchema>;
export type AgentActivityEvent = z.infer<typeof AgentActivityEventSchema>;
export type RunMetadata = z.infer<typeof RunMetadataSchema>;
