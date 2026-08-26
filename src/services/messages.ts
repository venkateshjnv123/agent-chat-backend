import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { enforceUserRunLimits } from "@/services/runLimits";
import { reclaimStaleRun } from "@/services/staleRuns";

/** Postgres raises this when a unique constraint is violated. */
const UNIQUE_VIOLATION = "P2002";

export class ActiveRunExistsError extends Error {
  constructor() {
    super("A run is already active for this chat");
    this.name = "ActiveRunExistsError";
  }
}

export class ChatNotFoundError extends Error {
  constructor() {
    super("Chat not found");
    this.name = "ChatNotFoundError";
  }
}

export class AttachmentBindingError extends Error {
  constructor() {
    super("Attachment is no longer ready for this message");
    this.name = "AttachmentBindingError";
  }
}

export type SendResult = {
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  runId: string;
  /** True when the same idempotency key was already accepted. */
  replayed: boolean;
};

/**
 * Accepts a message and opens a run, in one transaction.
 *
 * No model call happens here. The request writes rows, reserves the run, and
 * returns; the worker does the expensive part. That split is what lets a reload
 * mid-run recover instead of duplicating work.
 */
export async function acceptMessage(input: {
  /** Omitted on the first send: the chat is created in the same transaction. */
  chatId?: string;
  userAccountId: string;
  content: string;
  idempotencyKey: string;
  traceId: string;
  planMode?: boolean;
  attachmentIds?: string[];
  /** Original user copy, before attachment URLs are appended for the model. */
  titleSource?: string;
}): Promise<SendResult> {
  // A retried send must not open a second run. Checking first keeps the happy
  // path cheap; the unique constraint below is what actually guarantees it.
  const existing = await findAcceptedMessage(
    input.userAccountId,
    input.idempotencyKey,
  );

  if (existing) return existing;

  try {
    return await openRun(input);
  } catch (error) {
    if (error instanceof ActiveRunExistsError) {
      // Two first requests with the same key can both miss the optimistic read
      // and race on the unique constraint. The loser replays the winner rather
      // than reporting a false active-run conflict.
      const raced = await findAcceptedMessage(
        input.userAccountId,
        input.idempotencyKey,
      );

      if (raced) return raced;
    }

    // The chat may be locked by a run whose worker died. Releasing an expired
    // lease and trying once more is the difference between a chat that
    // recovers and one that returns 409 forever. Only once: a second failure
    // is a real conflict, not a stale one.
    if (error instanceof ActiveRunExistsError && input.chatId) {
      const { reclaimed } = await reclaimStaleRun(input.chatId);

      if (reclaimed) return await openRun(input);
    }

    throw error;
  }
}

async function findAcceptedMessage(
  ownerId: string,
  idempotencyKey: string,
): Promise<SendResult | null> {
  const existing = await prisma.agentRun.findUnique({
    where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
    include: { messages: { orderBy: { sequence: "asc" } } },
  });

  if (!existing) return null;

  const user = existing.messages.find((message) => message.role === "USER");
  const assistant = existing.messages.find(
    (message) => message.role === "ASSISTANT",
  );

  return {
    chatId: existing.chatId,
    userMessageId: user?.id ?? "",
    assistantMessageId: assistant?.id ?? "",
    runId: existing.id,
    replayed: true,
  };
}

async function openRun(input: {
  chatId?: string;
  userAccountId: string;
  content: string;
  idempotencyKey: string;
  traceId: string;
  planMode?: boolean;
  attachmentIds?: string[];
  titleSource?: string;
}): Promise<SendResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      await enforceUserRunLimits(tx, input.userAccountId);

      // A first send creates the chat here rather than in a separate request:
      // one round trip, and no empty chat is left behind if the send fails.
      const chatId = input.chatId
        ? await requireOwnedChat(tx, input.userAccountId, input.chatId)
        : (
            await tx.chat.create({
              data: {
                userId: input.userAccountId,
                title: deriveChatTitle(input.titleSource ?? input.content),
              },
            })
          ).id;

      if (input.chatId) {
        // A manually named chat wins. Only fill the initial null title, making
        // replay and later sends state-idempotent.
        await tx.chat.updateMany({
          where: { id: chatId, title: null },
          data: { title: deriveChatTitle(input.titleSource ?? input.content) },
        });
      }

      const run = await tx.agentRun.create({
        data: {
          chatId,
          ownerId: input.userAccountId,
          status: "QUEUED",
          idempotencyKey: input.idempotencyKey,
          planMode: input.planMode ?? false,
          traceId: input.traceId,
        },
      });

      const userMessage = await tx.message.create({
        data: {
          chatId,
          role: "USER",
          status: "SUCCESS",
          content: input.content,
          sequence: await nextSequence(tx, chatId),
          runId: run.id,
        },
      });

      await bindAttachmentsInTransaction(tx, {
        ownerId: input.userAccountId,
        chatId,
        messageId: userMessage.id,
        attachmentIds: input.attachmentIds ?? [],
      });

      // The placeholder exists before the worker starts so a client that mounts
      // mid-run has a row to attach streamed content to, rather than inventing
      // one and then colliding with the real message.
      const assistantMessage = await tx.message.create({
        data: {
          chatId,
          role: "ASSISTANT",
          status: "PENDING",
          content: "",
          sequence: await nextSequence(tx, chatId),
          runId: run.id,
        },
      });

      await tx.chat.update({
        where: { id: chatId },
        data: { updatedAt: new Date() },
      });

      return {
        chatId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        runId: run.id,
        replayed: false,
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    ) {
      // Either the partial unique index (another run is already active on this
      // chat) or a concurrent request with the same idempotency key. Both mean
      // the caller should not get a second run.
      throw new ActiveRunExistsError();
    }

    throw error;
  }
}

/** Stable title for recent-chat navigation; no second model call or race. */
export function deriveChatTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized).slice(0, 80).join("");

  return characters.length > 0 ? characters : "Untitled task";
}

/** Attachment ownership and message creation commit or roll back together. */
async function bindAttachmentsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    chatId: string;
    messageId: string;
    attachmentIds: string[];
  },
): Promise<void> {
  for (const [order, id] of input.attachmentIds.entries()) {
    const bound = await tx.attachment.updateMany({
      where: {
        id,
        ownerId: input.ownerId,
        status: "READY",
        messageId: null,
        OR: [{ chatId: null }, { chatId: input.chatId }],
      },
      data: {
        chatId: input.chatId,
        messageId: input.messageId,
        order,
      },
    });

    if (bound.count !== 1) throw new AttachmentBindingError();
  }
}

/**
 * Sequence is epoch millis, monotonic per chat.
 *
 * Two writes inside the same millisecond would collide on the unique
 * (chatId, sequence) constraint, so we step past the highest existing value
 * instead. Monotonic is what matters; contiguous is not.
 */
async function nextSequence(
  tx: Prisma.TransactionClient,
  chatId: string,
): Promise<bigint> {
  const latest = await tx.message.findFirst({
    where: { chatId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });

  const now = BigInt(Date.now());

  if (!latest) return now;

  return latest.sequence >= now ? latest.sequence + 1n : now;
}

/**
 * Ownership is re-checked inside the transaction.
 *
 * A guard outside it can be raced by a delete; checking here means the run and
 * the ownership decision commit or fail together.
 */
async function requireOwnedChat(
  tx: Prisma.TransactionClient,
  userAccountId: string,
  chatId: string,
): Promise<string> {
  const chat = await tx.chat.findFirst({
    where: { id: chatId, userId: userAccountId, deletedAt: null },
    select: { id: true },
  });

  if (!chat) throw new ChatNotFoundError();

  return chat.id;
}
