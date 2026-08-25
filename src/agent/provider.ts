/**
 * Provider-neutral agent interface.
 *
 * The orchestration layer knows only this shape. OpenRouter is one
 * implementation; swapping providers must not touch the loop, persistence, or
 * the tool registry.
 *
 * Tool calls are part of the interface rather than a provider detail: the loop
 * needs to know a turn stopped to call a tool, and it must not learn that from
 * an OpenRouter-shaped payload.
 */

export type ToolCall = {
  /** Provider-assigned id. Echoed back on the tool result message. */
  id: string;
  name: string;
  /** Raw arguments. Validation belongs to the registry, not the provider. */
  input: unknown;
};

export type AgentMessage =
  | { role: "user" | "system"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type AgentChunk =
  | { type: "text"; text: string }
  | {
      type: "done";
      routedModel: string | null;
      usage: TokenUsage | null;
      /** Empty unless the model chose to call tools. */
      toolCalls: ToolCall[];
      /** Why the model stopped. `tool_calls` means the loop must continue. */
      finishReason: string | null;
    };

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

/** JSON Schema tool definition, as the registry renders it. */
export type AgentTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AgentTurnRequest = {
  messages: AgentMessage[];
  tools?: AgentTool[];
  signal?: AbortSignal;
};

export interface AgentProvider {
  readonly name: string;
  /** Streams a single assistant turn. */
  stream(request: AgentTurnRequest): AsyncGenerator<AgentChunk>;
}

/** Raised when the provider returns a stream that produced no content. */
export class EmptyStreamError extends Error {
  constructor() {
    super("The model returned an empty response");
    this.name = "EmptyStreamError";
  }
}
