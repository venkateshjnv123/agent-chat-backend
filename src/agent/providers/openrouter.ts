import {
  EmptyStreamError,
  type AgentChunk,
  type AgentProvider,
  type AgentTurnRequest,
} from "@/agent/provider";
import { readRequiredEnv } from "@/env/server";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * OpenRouter implementation, pinned to the free model.
 *
 * There is deliberately no paid fallback: a provider outage must surface as a
 * visible failed turn, not a silent switch to a billable model. The model
 * actually served behind `openrouter/free` is recorded per run, because the
 * routed model is not knowable before the response arrives.
 */
export class OpenRouterProvider implements AgentProvider {
  readonly name = "openrouter";

  async *stream(request: AgentTurnRequest): AsyncGenerator<AgentChunk> {
    const { OPENROUTER_API_KEY, OPENROUTER_MODEL } = readRequiredEnv([
      "OPENROUTER_API_KEY",
      "OPENROUTER_MODEL",
    ]);

    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: request.signal,
      headers: {
        authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        stream: true,
        messages: request.messages,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`openrouter_http_${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let produced = false;
    let routedModel: string | null = null;
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a chunk boundary can split one.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));

        if (!line) continue;

        const payload = line.slice("data:".length).trim();

        if (payload === "[DONE]") continue;

        let parsed: OpenRouterFrame;

        try {
          parsed = JSON.parse(payload) as OpenRouterFrame;
        } catch {
          continue;
        }

        routedModel = parsed.model ?? routedModel;

        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          };
        }

        const text = parsed.choices?.[0]?.delta?.content;

        if (text) {
          produced = true;
          yield { type: "text", text };
        }
      }
    }

    if (!produced) throw new EmptyStreamError();

    yield { type: "done", routedModel, usage };
  }
}

type OpenRouterFrame = {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: { delta?: { content?: string } }[];
};
