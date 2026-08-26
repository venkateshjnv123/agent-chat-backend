import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveReadyAttachments = vi.fn<
  () => Promise<{ id: string; url: string }[]>
>(async () => []);
vi.mock("@/services/attachments", () => ({
  AttachmentError: class AttachmentError extends Error {},
  resolveReadyAttachments,
}));

const acceptMessage = vi.fn(async () => ({
  chatId: "chat_1",
  userMessageId: "message_user",
  assistantMessageId: "message_assistant",
  runId: "run_1",
  replayed: false,
}));
vi.mock("@/services/messages", () => ({
  ActiveRunExistsError: class ActiveRunExistsError extends Error {},
  AttachmentBindingError: class AttachmentBindingError extends Error {},
  ChatNotFoundError: class ChatNotFoundError extends Error {},
  acceptMessage,
}));

vi.mock("@/services/runLimits", () => ({
  UserRunLimitError: class UserRunLimitError extends Error {},
}));

const ensureRunDispatched = vi.fn(async () => ({
  triggerRunId: "trigger_default",
  realtimeToken: "token_default",
  expiresAt: new Date(),
}));
vi.mock("@/services/dispatchRun", () => ({ ensureRunDispatched }));

const { handleSend } = await import("@/services/send");

const context = {
  clerkUserId: "clerk_1",
  userAccountId: "owner_1",
  trace: "trace_1",
  sessionId: "session_1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("send dispatch recovery", () => {
  it("returns accepted durable ids when immediate Trigger delivery fails", async () => {
    ensureRunDispatched.mockRejectedValueOnce(new Error("offline"));

    const response = await handleSend(context, {
      content: "hello",
      idempotencyKey: "idempotency-1",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      chatId: "chat_1",
      messageId: "message_assistant",
      runId: "run_1",
      realtimeRunId: null,
      realtimeToken: "",
    });
  });

  it("replays an undispatched row through the same reconciler", async () => {
    acceptMessage.mockResolvedValueOnce({
      chatId: "chat_1",
      userMessageId: "message_user",
      assistantMessageId: "message_assistant",
      runId: "run_1",
      replayed: true,
    });
    ensureRunDispatched.mockResolvedValueOnce({
      triggerRunId: "trigger_1",
      realtimeToken: "token_1",
      expiresAt: new Date(),
    });

    const response = await handleSend(context, {
      content: "hello",
      idempotencyKey: "idempotency-1",
    });

    await expect(response.json()).resolves.toMatchObject({
      realtimeRunId: "trigger_1",
      realtimeToken: "token_1",
    });
    expect(ensureRunDispatched).toHaveBeenCalledWith("run_1", "session_1");
  });

  it("passes attached video URLs to the agent in the selected order", async () => {
    resolveReadyAttachments.mockResolvedValueOnce([
      { id: "video_1", url: "https://assets.test/first.mp4" },
      { id: "video_2", url: "https://assets.test/second.webm" },
    ]);

    await handleSend(context, {
      content: "Merge these videos",
      idempotencyKey: "idempotency-videos",
      attachmentIds: ["video_1", "video_2"],
    });

    expect(acceptMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Merge these videos\n\nAttached media (in order):\n" +
          "1. https://assets.test/first.mp4\n" +
          "2. https://assets.test/second.webm",
        titleSource: "Merge these videos",
        attachmentIds: ["video_1", "video_2"],
      }),
    );
  });
});
