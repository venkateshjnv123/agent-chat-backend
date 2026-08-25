import type {
  Attachment as AttachmentRow,
  Chat,
  Message,
  ToolInvocation as ToolInvocationRow,
} from "@/generated/prisma/client";
import {
  AssetSchema,
  ChatSummarySchema,
  ContentBlockSchema,
  MessageSchema,
  ToolInvocationSchema,
} from "@/contracts/chat";
import { AttachmentSchema } from "@/contracts/attachments";
import { z } from "zod";

/**
 * DB rows carry types the wire cannot: BigInt sequences and unvalidated JSONB.
 * Serializing through the contract schema means a malformed block written by a
 * past bug surfaces here rather than in the client.
 */
export function serializeChat(chat: Chat) {
  return ChatSummarySchema.parse({
    id: chat.id,
    title: chat.title,
    modelId: chat.modelId,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  });
}

export function serializeToolInvocation(invocation: ToolInvocationRow) {
  return ToolInvocationSchema.parse({
    id: invocation.id,
    toolName: invocation.toolName,
    rendererKey: invocation.rendererKey,
    state: invocation.state,
    sanitizedInput: invocation.sanitizedInput ?? {},
    result: invocation.result ?? null,
    resultUrl: invocation.resultUrl,
    // Internal error codes never cross this boundary; only the safe message does.
    userMessage: invocation.userMessage,
    creditUsed: invocation.creditUsed,
    startedAt: invocation.startedAt?.toISOString() ?? null,
    completedAt: invocation.completedAt?.toISOString() ?? null,
  });
}

export function serializeMessage(
  message: Message & {
    attachments?: AttachmentRow[];
    toolInvocations?: ToolInvocationRow[];
  },
) {
  return MessageSchema.parse({
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    status: message.status,
    content: message.content,
    // BigInt does not survive JSON, so sequence travels as a decimal string.
    sequence: message.sequence.toString(),
    contentBlocks: parseOrNull(
      z.array(ContentBlockSchema),
      message.contentBlocks,
    ),
    assets: parseOrNull(z.array(AssetSchema), message.assets),
    attachments: (message.attachments ?? []).map((attachment) =>
      AttachmentSchema.parse({
        id: attachment.id,
        status: attachment.status,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize,
        width: attachment.width,
        height: attachment.height,
        url: attachment.resultUrl,
        order: attachment.order,
        createdAt: attachment.createdAt.toISOString(),
        userMessage: null,
      }),
    ),
    runId: message.runId,
    creditUsed: message.creditUsed,
    tokenUsage: message.tokenUsage ?? null,
    aiModel: message.aiModel ?? null,
    metadata: message.metadata ?? null,
    toolInvocations: (message.toolInvocations ?? []).map(
      serializeToolInvocation,
    ),
    createdAt: message.createdAt.toISOString(),
  });
}

function parseOrNull<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): z.infer<T> | null {
  if (value === null || value === undefined) return null;

  const parsed = schema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
