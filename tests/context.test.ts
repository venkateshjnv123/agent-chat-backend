import { describe, expect, it } from "vitest";

import {
  MAX_CONTEXT_CHARACTERS,
  MAX_CONTEXT_MESSAGES,
  selectBoundedConversation,
} from "@/agent/context";

describe("bounded conversation restore", () => {
  it("returns newest rows in chronological order", () => {
    expect(
      selectBoundedConversation([
        { role: "USER", content: "new question" },
        { role: "ASSISTANT", content: "old answer" },
        { role: "USER", content: "old question" },
      ]),
    ).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
    ]);
  });

  it("caps message count and drops an orphan assistant at the boundary", () => {
    const rows = Array.from({ length: MAX_CONTEXT_MESSAGES + 5 }, (_, index) =>
      index % 2 === 0
        ? { role: "USER" as const, content: `question ${index}` }
        : { role: "ASSISTANT" as const, content: `answer ${index}` },
    );

    const result = selectBoundedConversation(rows);

    expect(result.length).toBeLessThanOrEqual(MAX_CONTEXT_MESSAGES);
    expect(result[0]?.role).toBe("user");
    expect(result.at(-1)?.content).toBe("question 0");
  });

  it("keeps the newest user turn even when it alone exceeds the budget", () => {
    const newest = "x".repeat(MAX_CONTEXT_CHARACTERS + 1);

    expect(
      selectBoundedConversation([
        { role: "USER", content: newest },
        { role: "ASSISTANT", content: "older answer" },
      ]),
    ).toEqual([{ role: "user", content: newest }]);
  });
});
