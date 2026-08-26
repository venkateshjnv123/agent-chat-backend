import { z } from "zod";

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
  /** Which model call inside the turn produced this text. */
  turn: z.number().int().min(1),
  text: z.string(),
});

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
  /** Set while a plan card is open, so a reloaded tab can fetch it. */
  waitpointId: z.string().optional(),
});

export type AssistantTextDelta = z.infer<typeof AssistantTextDeltaSchema>;
export type RunMetadata = z.infer<typeof RunMetadataSchema>;
