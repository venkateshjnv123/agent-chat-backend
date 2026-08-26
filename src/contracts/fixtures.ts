import type { z } from "zod";

import {
  AgentRunStateSchema,
  ChatListResponseSchema,
  ChatSummarySchema,
  MessageListResponseSchema,
  MessageSchema,
  SendMessageResponseSchema,
} from "./chat";
import type {
  CancelRunResponseSchema,
  RealtimeTokenResponseSchema,
} from "./chat";
import { CreditBalanceSchema, LedgerListResponseSchema } from "./credits";

/**
 * Fixture data for stub-first development (PLAN.md §1).
 *
 * Every route exists from hour one and returns one of these, so the frontend
 * builds against real URLs, real types and real status codes while the real
 * handlers are still being written. Each fixture is parsed against its own
 * schema in tests/fixtures.test.ts — a stub can never describe a shape the
 * real handler will not produce.
 *
 * Delete a fixture the moment its route is real.
 */

const NOW = "2026-08-25T02:00:00.000Z";

export const chatFixture: z.infer<typeof ChatSummarySchema> = {
  id: "chat_fixture_1",
  title: "Illustrating data pagination",
  modelId: "openrouter/free",
  pinned: false,
  createdAt: NOW,
  updatedAt: NOW,
};

export const chatListFixture: z.infer<typeof ChatListResponseSchema> = {
  items: [
    chatFixture,
    {
      id: "chat_fixture_2",
      title: "Video concept for a happy dog",
      modelId: "openrouter/free",
      pinned: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  nextCursor: null,
  hasMore: false,
};

export const userMessageFixture: z.infer<typeof MessageSchema> = {
  id: "msg_fixture_user",
  chatId: chatFixture.id,
  role: "USER",
  status: "SUCCESS",
  content: "Crop this image to the top half.",
  contentBlocks: null,
  assets: null,
  attachments: [],
  sequence: "1787591934048",
  runId: "run_fixture_1",
  creditUsed: 0,
  tokenUsage: null,
  aiModel: null,
  metadata: null,
  toolInvocations: [],
  createdAt: NOW,
};

export const assistantMessageFixture: z.infer<typeof MessageSchema> = {
  id: "msg_fixture_assistant",
  chatId: chatFixture.id,
  role: "ASSISTANT",
  status: "SUCCESS",
  content:
    "Done — here is the cropped image:\n\n![Cropped](https://example.invalid/gen/cropped.png)",
  contentBlocks: [
    {
      type: "thinking",
      thinking:
        "The user wants the top half, so height_percent 50 with y_percent 0.",
    },
    {
      type: "tool_use",
      id: "toolu_fixture_1",
      name: "crop_image",
      input: { image_url: "https://example.invalid/source.png" },
    },
    { type: "text", text: "Done — here is the cropped image:" },
  ],
  attachments: [],
  assets: [
    {
      type: "image",
      url: "https://example.invalid/gen/cropped.png",
      model: "crop_image",
      mode: "utility",
      creditUsed: 5000,
      toolCallId: "toolu_fixture_1",
      prompt: null,
      filename: "cropped.png",
      metadata: {
        mimeType: "image/png",
        width: 768,
        height: 512,
        fileSize: 240_128,
      },
    },
  ],
  sequence: "1787591947196",
  runId: "run_fixture_1",
  creditUsed: 5000,
  tokenUsage: { inputTokens: 42, outputTokens: 118 },
  aiModel: {
    id: "openrouter/free",
    name: "openrouter/free",
    provider: "openrouter",
  },
  metadata: { turns: 2, thinkingDurationSeconds: 3 },
  toolInvocations: [
    {
      id: "inv_fixture_1",
      toolName: "crop_image",
      rendererKey: "image",
      state: "COMPLETED",
      sanitizedInput: {
        image_url: "https://example.invalid/source.png",
        x_percent: 0,
        y_percent: 0,
        width_percent: 100,
        height_percent: 50,
      },
      result: {
        type: "image",
        urls: ["https://example.invalid/gen/cropped.png"],
        width: 768,
        height: 512,
        mimeType: "image/png",
      },
      resultUrl: "https://example.invalid/gen/cropped.png",
      userMessage: null,
      creditUsed: 5000,
      startedAt: NOW,
      completedAt: NOW,
    },
  ],
  createdAt: NOW,
};

export const messageListFixture: z.infer<typeof MessageListResponseSchema> = {
  items: [assistantMessageFixture, userMessageFixture],
  nextCursor: null,
  hasMore: false,
};

export const sendMessageFixture: z.infer<typeof SendMessageResponseSchema> = {
  chatId: chatFixture.id,
  messageId: "msg_fixture_new",
  runId: "run_fixture_new",
  realtimeRunId: "run_trigger_fixture",
  realtimeToken: "fixture-realtime-token",
};

export const runStateFixture: z.infer<typeof AgentRunStateSchema> = {
  id: "run_fixture_1",
  chatId: chatFixture.id,
  status: "COMPLETED",
  turns: 2,
  routedModel: "openrouter/free",
  userMessage: null,
  retryable: false,
  cancellationRequestedAt: null,
  startedAt: NOW,
  completedAt: NOW,
};

export const creditBalanceFixture: z.infer<typeof CreditBalanceSchema> = {
  availableBalance: 5_000_000,
  reservedBalance: 0,
  formatted: "5.00",
};

export const ledgerListFixture: z.infer<typeof LedgerListResponseSchema> = {
  items: [
    {
      id: "led_fixture_2",
      delta: -5000,
      kind: "SETTLE",
      toolName: "crop_image",
      runId: "run_fixture_1",
      toolInvocationId: "inv_fixture_1",
      zeroRated: false,
      note: null,
      createdAt: NOW,
    },
    {
      id: "led_fixture_1",
      delta: 0,
      kind: "SETTLE",
      toolName: null,
      runId: "run_fixture_1",
      toolInvocationId: null,
      zeroRated: true,
      note: "model usage recorded at zero application credits",
      createdAt: NOW,
    },
  ],
  nextCursor: null,
  hasMore: false,
};

export const realtimeTokenFixture: z.infer<typeof RealtimeTokenResponseSchema> =
  {
    runId: "run_fixture_1",
    realtimeRunId: "run_trigger_fixture",
    realtimeToken: "fixture-realtime-token",
    expiresAt: "2026-08-25T03:00:00.000Z",
  };

export const cancelRunFixture: z.infer<typeof CancelRunResponseSchema> = {
  runId: "run_fixture_1",
  status: "CANCELLED",
  cancelled: true,
};
