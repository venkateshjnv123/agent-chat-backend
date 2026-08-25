import {
  EmptyStreamError,
  type AgentChunk,
  type AgentMessage,
  type AgentProvider,
  type AgentTurnRequest,
  type ToolCall,
} from "@/agent/provider";
import {
  DEFAULT_RETRY,
  TransientProviderError,
  classifyHttp,
  withProviderRetry,
  type RetryOptions,
} from "@/agent/retry";
import { readRequiredEnv } from "@/env/server";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Ceiling on waiting for response headers. */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Ceiling on the gap between two stream frames.
 *
 * A total deadline would kill a long, healthy answer. What actually needs
 * catching is a connection that was accepted and then went quiet, which a
 * whole-request timeout only notices minutes later.
 */
const IDLE_TIMEOUT_MS = 60_000;

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

  /** Injectable so tests can drive the backoff without real delays. */
  constructor(
    private readonly retry: Pick<
      RetryOptions,
      "attempts" | "initialDelayMs" | "maxDelayMs" | "sleep"
    > = DEFAULT_RETRY,
  ) {}

  /**
   * Opens the stream, retrying transient refusals.
   *
   * Only the connect phase is retried. Once a frame has been yielded the text
   * is already in the user's transcript, and starting again would duplicate it;
   * a drop after that point surfaces as a failed, retryable turn instead.
   */
  private async open(request: AgentTurnRequest): Promise<Response> {
    const { OPENROUTER_API_KEY, OPENROUTER_MODEL } = readRequiredEnv([
      "OPENROUTER_API_KEY",
      "OPENROUTER_MODEL",
    ]);

    return withProviderRetry(
      async () => {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          signal: withTimeout(request.signal, CONNECT_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            stream: true,
            messages: request.messages.map(toWireMessage),
            ...(request.tools?.length ? { tools: request.tools } : {}),
          }),
        });

        if (!response.ok) {
          // Read the body before classifying: the status alone does not say
          // whether a 400 was our malformed request or the provider's quota.
          throw classifyHttp(
            response.status,
            await response.text().catch(() => ""),
          );
        }

        if (!response.body) {
          throw new TransientProviderError(
            "openrouter_no_body",
            response.status,
          );
        }

        return response;
      },
      { ...this.retry, signal: request.signal },
    );
  }

  async *stream(request: AgentTurnRequest): AsyncGenerator<AgentChunk> {
    const response = await this.open(request);
    const body = response.body!;

    const reader = body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let produced = false;
    let finishReason: string | null = null;
    // Tool calls stream in fragments keyed by index: the name arrives once and
    // the arguments accumulate across frames, so they are assembled here rather
    // than parsed per frame.
    const partialCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let routedModel: string | null = null;
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    while (true) {
      const { done, value } = await readWithIdleTimeout(reader);

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

        const choice = parsed.choices?.[0];

        finishReason = choice?.finish_reason ?? finishReason;

        const text = choice?.delta?.content;

        if (text) {
          produced = true;
          yield { type: "text", text };
        }

        for (const fragment of choice?.delta?.tool_calls ?? []) {
          const existing = partialCalls.get(fragment.index) ?? {
            id: "",
            name: "",
            args: "",
          };

          partialCalls.set(fragment.index, {
            id: fragment.id ?? existing.id,
            name: fragment.function?.name ?? existing.name,
            args: existing.args + (fragment.function?.arguments ?? ""),
          });

          // A turn that only calls a tool emits no text, and that is a complete
          // turn — not the empty stream the error is for.
          produced = true;
        }
      }
    }

    if (!produced) throw new EmptyStreamError();

    yield {
      type: "done",
      routedModel,
      usage,
      toolCalls: assembleToolCalls(partialCalls),
      finishReason,
    };
  }
}

/**
 * Finishes the accumulated fragments.
 *
 * Arguments arrive as a JSON string built across frames. Unparseable JSON is
 * passed through as `{}` rather than thrown: the registry validates input and
 * turns a bad call into one failed step, which beats failing the whole turn.
 */
function assembleToolCalls(
  partial: Map<number, { id: string; name: string; args: string }>,
): ToolCall[] {
  return [...partial.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name.length > 0)
    .map(([index, call]) => {
      let input: unknown = {};

      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        input = {};
      }

      return {
        // Some providers omit the id on a single call; the index keeps it unique
        // within the turn, which is all the execution key needs.
        id: call.id || `call_${index}`,
        name: call.name,
        input,
      };
    });
}

/** Maps our provider-neutral message onto the OpenAI-shaped wire format. */
function toWireMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input),
        },
      })),
    };
  }

  return { role: message.role, content: message.content };
}

type OpenRouterFrame = {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
};

/**
 * Combines the caller's cancellation with a deadline.
 *
 * `AbortSignal.any` keeps the two reasons distinct: an abort from the stop
 * button is a cancelled run, a `TimeoutError` is a transient provider failure,
 * and the retry layer has to be able to tell them apart.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);

  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * Reads one chunk, failing if the connection goes quiet.
 *
 * A stalled read is indistinguishable from a slow model at the socket level, so
 * the gap between frames is what gets the deadline rather than the request as a
 * whole. Racing the timer leaves the read pending, which is fine: the reader is
 * discarded with the response when the generator unwinds.
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("openrouter_stream_idle");

          error.name = "TimeoutError";
          reject(error);
        }, IDLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
