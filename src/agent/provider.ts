/**
 * Provider-neutral agent interface.
 *
 * The orchestration layer knows only this shape. OpenRouter is one
 * implementation; swapping providers must not touch the loop, persistence, or
 * the tool registry. Tool support lands with the registry in Phase 1.
 */

export type AgentMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type AgentChunk =
  | { type: "text"; text: string }
  | { type: "done"; routedModel: string | null; usage: TokenUsage | null };

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type AgentTurnRequest = {
  messages: AgentMessage[];
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
