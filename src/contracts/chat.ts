import { z } from "zod";

import { paginated } from "./common";

/**
 * Message sequence is epoch millis, monotonic per chat. It is the pagination
 * cursor and the reload-recovery key. Serialised as a string because it is a
 * BigInt in Postgres and JSON numbers lose precision above 2^53.
 */
export const SequenceSchema = z.string().regex(/^\d+$/);

export const MessageRoleSchema = z.enum(["USER", "ASSISTANT"]);

export const MessageStatusSchema = z.enum([
  "PENDING",
  "STREAMING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
]);

export const RunStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "WAITING",
  // Cancellation requested, worker not yet stopped. The composer renders this
  // as "stopping" rather than pretending the run already ended.
  "CANCELLING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const ToolStateSchema = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

/**
 * Closed set of renderers the UI knows how to draw.
 *
 * `.catch("generic")` means a tool added after the client shipped degrades to a
 * plain card instead of failing the whole message parse — a forward-compatible
 * default, not an accident.
 */
export const RendererKeySchema = z
  .enum([
    "image",
    "video",
    "audio",
    "text",
    "schema",
    "skill",
    "plan",
    "generic",
  ])
  .catch("generic");

/**
 * Typed tool output. Discriminated on `type` so the renderer never inspects an
 * open record to decide what it is looking at.
 */
export const ToolResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    urls: z.array(z.url()).min(1),
    width: z.number().int().positive().nullable().default(null),
    height: z.number().int().positive().nullable().default(null),
    mimeType: z.string().default("image/png"),
  }),
  z.object({
    type: z.literal("video"),
    urls: z.array(z.url()).min(1),
    durationSeconds: z.number().nonnegative().nullable().default(null),
    mimeType: z.string().default("video/mp4"),
  }),
  z.object({
    type: z.literal("audio"),
    urls: z.array(z.url()).min(1),
    durationSeconds: z.number().nonnegative().nullable().default(null),
    mimeType: z.string().default("audio/mpeg"),
  }),
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  // Structured payloads with no media: schema lookups, skill loads, estimates.
  z.object({
    type: z.literal("data"),
    data: z.record(z.string(), z.unknown()),
  }),
]);

/** Anthropic-native content blocks, stored verbatim. */
export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thinking"),
    thinking: z.string(),
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
]);

/** A generated artifact. Uploads are Attachments; these are tool output. */
export const AssetSchema = z.object({
  type: z.enum(["image", "video", "audio"]),
  url: z.url(),
  model: z.string().nullable(),
  mode: z.string().nullable(),
  creditUsed: z.number().int().nonnegative(),
  toolCallId: z.string().nullable(),
  prompt: z.string().nullable(),
  filename: z.string().nullable(),
  metadata: z.object({
    mimeType: z.string(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    fileSize: z.number().int().nonnegative().nullable(),
  }),
});

/**
 * One row per real tool execution. Thinking and text live only in
 * contentBlocks. Step duration in the UI is completedAt - startedAt.
 */
export const ToolInvocationSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  rendererKey: RendererKeySchema,
  state: ToolStateSchema,
  sanitizedInput: z.record(z.string(), z.unknown()),
  result: ToolResultSchema.nullable(),
  resultUrl: z.url().nullable(),
  /** User-safe. Internal error codes never cross this boundary. */
  userMessage: z.string().nullable(),
  creditUsed: z.number().int().nonnegative(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

export const MessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: MessageRoleSchema,
  status: MessageStatusSchema,
  content: z.string(),
  contentBlocks: z.array(ContentBlockSchema).nullable(),
  assets: z.array(AssetSchema).nullable(),
  sequence: SequenceSchema,
  runId: z.string().nullable(),
  creditUsed: z.number().int().nonnegative(),
  tokenUsage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .nullable(),
  aiModel: z
    .object({ id: z.string(), name: z.string(), provider: z.string() })
    .nullable(),
  metadata: z
    .object({
      turns: z.number().int().nonnegative(),
      thinkingDurationSeconds: z.number().nonnegative().nullable(),
    })
    .nullable(),
  toolInvocations: z.array(ToolInvocationSchema),
  createdAt: z.iso.datetime(),
});

export const ChatSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  modelId: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const AgentRunStateSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: RunStatusSchema,
  turns: z.number().int().nonnegative(),
  routedModel: z.string().nullable(),
  /** User-safe explanation of a failure. Internal codes stay in the logs. */
  userMessage: z.string().nullable(),
  /** Whether the frontend may offer a retry for this failure (Phase 3). */
  retryable: z.boolean().default(false),
  cancellationRequestedAt: z.iso.datetime().nullable().default(null),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

// ── requests ────────────────────────────────────────────────────────────────

export const CreateChatRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export const SendMessageRequestSchema = z.object({
  /**
   * Omitted on a first send: the backend creates the chat in the same
   * transaction and returns its id, so the client never pre-creates an empty
   * chat that a failed send would leave behind.
   */
  chatId: z.string().optional(),
  content: z.string().min(1).max(16_000),
  /** Client-generated, reused when retrying the same logical send. */
  idempotencyKey: z.string().min(8).max(128),
  attachmentIds: z.array(z.string()).max(10).optional(),
  /**
   * Composer plan mode. When set, a turn that wants to run tools pauses and
   * shows its plan for approval before spending anything.
   */
  planMode: z.boolean().default(false),
});

export const ListMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── responses ───────────────────────────────────────────────────────────────

export const ChatListResponseSchema = paginated(ChatSummarySchema);
export const MessageListResponseSchema = paginated(MessageSchema);

/**
 * The send envelope. Adds realtimeRunId to the reference shape because our
 * internal run id and Trigger.dev subscription id are intentionally distinct.
 */
export const SendMessageResponseSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  /** Internal AgentRun id used by our REST reconciliation/cancel routes. */
  runId: z.string(),
  /** Trigger.dev run id used only by the realtime subscription hook. */
  realtimeRunId: z.string().nullable(),
  realtimeToken: z.string(),
});

/** Fresh scoped realtime token, for initial mount, reload and expiry. */
export const RealtimeTokenResponseSchema = z.object({
  /** Internal AgentRun id used by our REST reconciliation/cancel routes. */
  runId: z.string(),
  /** Trigger.dev run id covered by realtimeToken. */
  realtimeRunId: z.string(),
  realtimeToken: z.string(),
  expiresAt: z.iso.datetime(),
});

export const CancelRunResponseSchema = z.object({
  runId: z.string(),
  status: RunStatusSchema,
  /** False when the run was already terminal — cancelling twice is safe. */
  cancelled: z.boolean(),
});

export type RendererKey = z.infer<typeof RendererKeySchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ChatSummary = z.infer<typeof ChatSummarySchema>;
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;
export type RealtimeTokenResponse = z.infer<typeof RealtimeTokenResponseSchema>;
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;
