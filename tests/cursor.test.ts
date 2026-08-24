import { describe, expect, it } from "vitest";

import {
  decodeChatCursor,
  decodeSequenceCursor,
  encodeCursor,
} from "@/db/cursor";

describe("cursors", () => {
  it("round-trips a message sequence", () => {
    const cursor = encodeCursor(["1787591934048"]);

    expect(decodeSequenceCursor(cursor)).toBe(1787591934048n);
  });

  it("round-trips a chat position", () => {
    const updatedAt = "2026-08-25T02:00:00.000Z";
    const decoded = decodeChatCursor(encodeCursor([updatedAt, "chat_1"]));

    expect(decoded?.id).toBe("chat_1");
    expect(decoded?.updatedAt.toISOString()).toBe(updatedAt);
  });

  it("rejects a malformed cursor rather than paging from the start", () => {
    expect(decodeSequenceCursor("not-base64!")).toBeNull();
    expect(decodeChatCursor(encodeCursor(["only-one-part"]))).toBeNull();
  });
});
