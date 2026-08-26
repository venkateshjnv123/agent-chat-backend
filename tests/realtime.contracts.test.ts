import { describe, expect, it } from "vitest";

import {
  AgentActivityEventSchema,
  AssistantTextDeltaSchema,
  RunMetadataSchema,
} from "@/contracts/realtime";

describe("realtime contracts", () => {
  it("keys text deltas by stable run/message id and sequence", () => {
    expect(
      AssistantTextDeltaSchema.parse({
        runId: "run_1",
        messageId: "message_1",
        sequence: 2,
        turn: 1,
        text: "hello",
      }),
    ).toMatchObject({ sequence: 2, text: "hello" });
    expect(
      AssistantTextDeltaSchema.safeParse({
        runId: "run_1",
        messageId: "message_1",
        sequence: 0,
        turn: 1,
        text: "duplicate",
      }).success,
    ).toBe(false);
  });

  it("validates real thinking, tool, asset, and progress events", () => {
    const base = { runId: "run_1", messageId: "message_1" };
    const events = [
      {
        ...base,
        sequence: 1,
        type: "thinking",
        text: "Checking tools",
        elapsedMs: 20,
      },
      {
        ...base,
        sequence: 2,
        type: "progress",
        stage: "running_tools",
        currentStep: "crop_image",
        progress: 0.5,
      },
      {
        ...base,
        sequence: 3,
        type: "tool",
        toolCallId: "call_1",
        toolName: "crop_image",
        state: "RUNNING",
        result: null,
      },
      {
        ...base,
        sequence: 4,
        type: "asset",
        toolCallId: "call_1",
        assetType: "image",
        url: "https://example.com/out.png",
      },
    ];

    for (const event of events) {
      expect(AgentActivityEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("bounds coarse progress metadata", () => {
    expect(
      RunMetadataSchema.safeParse({ status: "running", progress: 2 }).success,
    ).toBe(false);
  });
});
