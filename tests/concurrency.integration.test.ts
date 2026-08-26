import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { ActiveRunExistsError, acceptMessage } from "@/services/messages";

const CLERK_ID = "test_concurrency_user";

/**
 * These assertions are the Phase 0 gate: a second concurrent send must be
 * rejected by Postgres, and a retried send must not open a second run.
 * Both are enforced by constraints, not by application code, so they hold
 * across serverless instances.
 */
/**
 * Opt-in: these write to the real database, so they run only when asked
 * (`RUN_DB_TESTS=1 pnpm test`). Keeping them out of the default suite means
 * `pnpm test` stays fast, offline, and safe to run in a loop.
 */
const hasLiveDatabase =
  !!process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.includes("POOLED_HOST") &&
  !process.env.DATABASE_URL.includes("USER:PASSWORD");

const describeIntegration =
  process.env.RUN_DB_TESTS === "1" && hasLiveDatabase
    ? describe
    : describe.skip;

describeIntegration("send path concurrency", { timeout: 30_000 }, () => {
  afterAll(async () => {
    await prisma.userAccount
      .delete({ where: { clerkUserId: CLERK_ID } })
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  async function freshChat() {
    const user = await prisma.userAccount.upsert({
      where: { clerkUserId: CLERK_ID },
      update: {},
      create: { clerkUserId: CLERK_ID, creditAccount: { create: {} } },
    });

    const chat = await prisma.chat.create({
      data: { userId: user.id, title: "probe" },
    });

    return { chat, userAccountId: user.id };
  }

  it("rejects a second active run on the same chat", async () => {
    const { chat, userAccountId } = await freshChat();

    const first = await acceptMessage({
      chatId: chat.id,
      userAccountId,
      content: "first",
      idempotencyKey: `idem-${chat.id}-1`,
      traceId: "trace-1",
    });

    expect(first.replayed).toBe(false);

    await expect(
      acceptMessage({
        chatId: chat.id,
        userAccountId,
        content: "second",
        idempotencyKey: `idem-${chat.id}-2`,
        traceId: "trace-2",
      }),
    ).rejects.toBeInstanceOf(ActiveRunExistsError);

    await prisma.chat.delete({ where: { id: chat.id } });
  });

  it("replays the same run for a repeated idempotency key", async () => {
    const { chat, userAccountId } = await freshChat();
    const key = `idem-${chat.id}-replay`;

    const first = await acceptMessage({
      chatId: chat.id,
      userAccountId,
      content: "hello",
      idempotencyKey: key,
      traceId: "trace-3",
    });

    const retried = await acceptMessage({
      chatId: chat.id,
      userAccountId,
      content: "hello",
      idempotencyKey: key,
      traceId: "trace-4",
    });

    expect(retried.replayed).toBe(true);
    expect(retried.runId).toBe(first.runId);

    // The retry must not have written a second pair of messages.
    const messages = await prisma.message.count({ where: { chatId: chat.id } });
    expect(messages).toBe(2);

    await prisma.chat.delete({ where: { id: chat.id } });
  });

  it("scopes an idempotency key to its authenticated owner", async () => {
    const first = await freshChat();
    const other = await prisma.userAccount.upsert({
      where: { clerkUserId: `${CLERK_ID}_other` },
      update: {},
      create: {
        clerkUserId: `${CLERK_ID}_other`,
        creditAccount: { create: {} },
      },
    });
    const sharedKey = `shared-${crypto.randomUUID()}`;

    const ownerRun = await acceptMessage({
      userAccountId: first.userAccountId,
      content: "owner",
      idempotencyKey: sharedKey,
      traceId: "trace-owner",
    });
    const otherRun = await acceptMessage({
      userAccountId: other.id,
      content: "other",
      idempotencyKey: sharedKey,
      traceId: "trace-other",
    });

    expect(otherRun.runId).not.toBe(ownerRun.runId);
    expect(otherRun.chatId).not.toBe(ownerRun.chatId);

    await prisma.userAccount.delete({ where: { id: other.id } });
    await prisma.chat.delete({ where: { id: ownerRun.chatId } });
    await prisma.chat.delete({ where: { id: first.chat.id } });
  });

  it("allows a new run once the previous one is terminal", async () => {
    const { chat, userAccountId } = await freshChat();

    const first = await acceptMessage({
      chatId: chat.id,
      userAccountId,
      content: "one",
      idempotencyKey: `idem-${chat.id}-a`,
      traceId: "trace-5",
    });

    await prisma.agentRun.update({
      where: { id: first.runId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const second = await acceptMessage({
      chatId: chat.id,
      userAccountId,
      content: "two",
      idempotencyKey: `idem-${chat.id}-b`,
      traceId: "trace-6",
    });

    expect(second.runId).not.toBe(first.runId);

    // Sequence must stay strictly increasing across runs.
    const rows = await prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { sequence: "asc" },
      select: { sequence: true },
    });

    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].sequence > rows[i - 1].sequence).toBe(true);
    }

    await prisma.chat.delete({ where: { id: chat.id } });
  });

  it("binds attachments in the same transaction as the accepted message", async () => {
    const { chat, userAccountId } = await freshChat();
    const attachment = await prisma.attachment.create({
      data: {
        ownerId: userAccountId,
        chatId: chat.id,
        status: "READY",
        resultUrl: "https://cdn.example.test/image.png",
      },
    });

    const accepted = await acceptMessage({
      chatId: chat.id,
      userAccountId,
      content: "edit this",
      titleSource: "edit this",
      attachmentIds: [attachment.id],
      idempotencyKey: `attachment-${chat.id}`,
      traceId: "trace-attachment",
    });
    const bound = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachment.id },
    });

    expect(bound.messageId).toBe(accepted.userMessageId);
    expect(bound.chatId).toBe(accepted.chatId);

    await prisma.chat.delete({ where: { id: chat.id } });
  });
});
