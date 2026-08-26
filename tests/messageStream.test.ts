import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn(async () => ({ count: 1 }));

vi.mock("@/db/client", () => ({
  prisma: { message: { updateMany } },
}));

const { checkpointAssistantText } = await import("@/services/messageStream");

beforeEach(() => vi.clearAllMocks());

describe("assistant stream checkpoints", () => {
  it("writes partial text only while the message is non-terminal", async () => {
    await expect(
      checkpointAssistantText("message_1", "partial answer"),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "message_1",
        status: { in: ["PENDING", "STREAMING"] },
      },
      data: { content: "partial answer", status: "STREAMING" },
    });
  });

  it("reports a terminal-row race without overwriting it", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      checkpointAssistantText("message_1", "stale answer"),
    ).resolves.toBe(false);
  });
});
