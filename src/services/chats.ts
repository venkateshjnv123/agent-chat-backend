import type { UpdateChatRequest } from "@/contracts/chat";
import { prisma } from "@/db/client";

const ACTIVE_RUN_STATES = [
  "QUEUED",
  "RUNNING",
  "WAITING",
  "CANCELLING",
] as const;

export class ChatMutationError extends Error {
  constructor(
    readonly code: "chat_not_found" | "chat_active",
    readonly status: 404 | 409,
  ) {
    super(code);
    this.name = "ChatMutationError";
  }
}

/** Rename and pin only an active chat owned by the caller. */
export async function updateOwnedChat(
  ownerId: string,
  chatId: string,
  patch: UpdateChatRequest,
) {
  const current = await prisma.chat.findFirst({
    where: { id: chatId, userId: ownerId, deletedAt: null },
  });

  if (!current) throw new ChatMutationError("chat_not_found", 404);

  const data = {
    ...(patch.title !== undefined && patch.title !== current.title
      ? { title: patch.title }
      : {}),
    ...(patch.pinned !== undefined && patch.pinned !== current.pinned
      ? { pinned: patch.pinned }
      : {}),
  };

  // A repeated PATCH is state-idempotent and does not reshuffle updatedAt.
  if (Object.keys(data).length === 0) return current;

  return prisma.chat.update({ where: { id: current.id }, data });
}

/**
 * Hides a chat without destroying its audit trail.
 *
 * Deleting while work is active would hide the only stop/approval controls
 * while a provider may still spend credits, so the caller must stop first.
 * A repeated delete returns the same successful state.
 */
export async function softDeleteOwnedChat(ownerId: string, chatId: string) {
  return prisma.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({
      where: { id: chatId, userId: ownerId },
      select: { id: true, deletedAt: true },
    });

    if (!chat) throw new ChatMutationError("chat_not_found", 404);
    if (chat.deletedAt) return { id: chat.id, deleted: true as const };

    const active = await tx.agentRun.findFirst({
      where: { chatId, status: { in: [...ACTIVE_RUN_STATES] } },
      select: { id: true },
    });

    if (active) throw new ChatMutationError("chat_active", 409);

    await tx.chat.update({
      where: { id: chat.id },
      data: { deletedAt: new Date(), pinned: false },
    });

    return { id: chat.id, deleted: true as const };
  });
}
