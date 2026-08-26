import { describe, expect, it } from "vitest";

import { SendMessageRequestSchema } from "@/contracts/chat";
import { deriveChatTitle } from "@/services/messages";

describe("message acceptance helpers", () => {
  it("derives a compact stable title from the first user message", () => {
    expect(deriveChatTitle("  Make   a launch poster\nfor Friday  ")).toBe(
      "Make a launch poster for Friday",
    );
    expect(deriveChatTitle("x".repeat(100))).toHaveLength(80);
  });

  it("rejects duplicate attachment ids before opening a transaction", () => {
    expect(
      SendMessageRequestSchema.safeParse({
        content: "edit this",
        idempotencyKey: "idempotency-1",
        attachmentIds: ["attachment_1", "attachment_1"],
      }).success,
    ).toBe(false);
  });
});
