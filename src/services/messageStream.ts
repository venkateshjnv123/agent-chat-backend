import { prisma } from "@/db/client";

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
