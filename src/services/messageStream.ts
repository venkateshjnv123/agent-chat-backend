import { prisma } from "@/db/client";
import type { ContentBlock } from "@/contracts/chat";

/** Avoid one database write per token while keeping crash loss small. */
export const STREAM_CHECKPOINT_INTERVAL_MS = 1_000;
export const STREAM_CHECKPOINT_CHARACTERS = 256;

/**
 * Persists recoverable partial assistant text.
 *
 * The conditional update prevents a stale worker from changing a terminal
 * message after cancellation, failure, completion, or an explicit retry.
 */
export async function checkpointAssistantText(
  messageId: string,
  content: string,
): Promise<boolean> {
  const updated = await prisma.message.updateMany({
    where: { id: messageId, status: { in: ["PENDING", "STREAMING"] } },
    data: { content, status: "STREAMING" },
  });

  return updated.count > 0;
}

/** Persists ordered partial text/reasoning so reload reconstructs live state. */
export async function checkpointAssistantState(options: {
  messageId: string;
  content: string;
  blocks: ContentBlock[];
  reasoning: string | null;
  turns: number;
  thinkingDurationSeconds: number;
}): Promise<boolean> {
  const updated = await prisma.message.updateMany({
    where: {
      id: options.messageId,
      status: { in: ["PENDING", "STREAMING"] },
    },
    data: {
      content: options.content,
      contentBlocks: options.blocks as never,
      reasoning: options.reasoning,
      status: "STREAMING",
      metadata: {
        turns: options.turns,
        thinkingDurationSeconds: options.thinkingDurationSeconds,
      },
    },
  });

  return updated.count > 0;
}
