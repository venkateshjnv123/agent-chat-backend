import { describe, expect, it } from "vitest";

import {
  AgentRunStateSchema,
  ChatListResponseSchema,
  ChatSummarySchema,
  MessageListResponseSchema,
  SendMessageResponseSchema,
} from "@/contracts/chat";
import { CreditBalanceSchema, LedgerListResponseSchema } from "@/contracts/credits";
import {
  assistantMessageFixture,
  chatFixture,
  chatListFixture,
  creditBalanceFixture,
  ledgerListFixture,
  messageListFixture,
  runStateFixture,
  sendMessageFixture,
  userMessageFixture,
} from "@/contracts/fixtures";
import { MessageSchema } from "@/contracts/chat";

/**
 * Stub-first only works if a fixture can never describe a shape the real
 * handler will not produce. Every fixture parses against its own contract.
 */
describe("fixtures satisfy their contracts", () => {
  it.each([
    ["chat", ChatSummarySchema, chatFixture],
    ["chat list", ChatListResponseSchema, chatListFixture],
    ["user message", MessageSchema, userMessageFixture],
    ["assistant message", MessageSchema, assistantMessageFixture],
    ["message list", MessageListResponseSchema, messageListFixture],
    ["send message", SendMessageResponseSchema, sendMessageFixture],
    ["run state", AgentRunStateSchema, runStateFixture],
    ["credit balance", CreditBalanceSchema, creditBalanceFixture],
    ["ledger list", LedgerListResponseSchema, ledgerListFixture],
  ])("%s", (_name, schema, fixture) => {
    expect(() => schema.parse(fixture)).not.toThrow();
  });
});
