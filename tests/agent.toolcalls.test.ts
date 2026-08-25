import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "@/agent/providers/openrouter";
import type { AgentChunk } from "@/agent/provider";

/**
 * Streaming behaviour of the provider, against hand-built SSE frames.
 *
 * Tool calls arrive fragmented — the name in one frame, the arguments split
 * across several — so the assembly is what these tests pin down. A provider
 * that silently drops a fragment produces a call with truncated JSON, which
 * would surface much later as an unexplained validation failure.
 */

function sse(frames: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      for (const frame of frames) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
      }

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, { status: 200 });
}

async function collect(frames: unknown[]): Promise<AgentChunk[]> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sse(frames)),
  );

  const chunks: AgentChunk[] = [];

  for await (const chunk of new OpenRouterProvider().stream({
    messages: [{ role: "user", content: "crop it" }],
  })) {
    chunks.push(chunk);
  }

  return chunks;
}

function lastBody(): Record<string, unknown> {
  const mock = fetch as unknown as { mock: { calls: [string, RequestInit][] } };

  return JSON.parse(mock.mock.calls[0][1].body as string);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter tool streaming", () => {
  it("assembles a tool call from fragments spread across frames", async () => {
    const chunks = await collect([
      {
        model: "z/free",
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "crop_image" } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"image_url":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"https://x.test/a.png"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    const done = chunks.at(-1);

    expect(done).toMatchObject({
      type: "done",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_a",
          name: "crop_image",
          input: { image_url: "https://x.test/a.png" },
        },
      ],
    });
  });

  it("keeps parallel tool calls apart and in index order", async () => {
    const chunks = await collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_b",
                  function: { name: "merge_videos", arguments: "{}" },
                },
                {
                  index: 0,
                  id: "call_a",
                  function: { name: "crop_image", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    const done = chunks.at(-1) as Extract<AgentChunk, { type: "done" }>;

    expect(done.toolCalls.map((call) => call.name)).toEqual([
      "crop_image",
      "merge_videos",
    ]);
  });

  it("treats a tool-only turn as content, not an empty stream", async () => {
    await expect(
      collect([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_a",
                    function: { name: "crop_image", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    ).resolves.toBeTruthy();
  });

  it("passes malformed argument JSON through for the registry to reject", async () => {
    const chunks = await collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  function: { name: "crop_image", arguments: "{not json" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    const done = chunks.at(-1) as Extract<AgentChunk, { type: "done" }>;

    expect(done.toolCalls[0].input).toEqual({});
  });

  it("still streams plain text turns with no tool calls", async () => {
    const chunks = await collect([
      { choices: [{ delta: { content: "Hello" } }] },
      {
        choices: [{ delta: { content: " there" } }, { finish_reason: "stop" }],
      },
    ]);

    expect(chunks.filter((chunk) => chunk.type === "text")).toHaveLength(2);
    expect(chunks.at(-1)).toMatchObject({ type: "done", toolCalls: [] });
  });

  it("sends the registry tools and maps tool results onto the wire format", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([{ choices: [{ delta: { content: "ok" } }] }])),
    );

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "crop_image",
          description: "crop",
          parameters: { type: "object" },
        },
      },
    ];

    for await (const _ of new OpenRouterProvider().stream({
      messages: [
        { role: "user", content: "crop it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_a", name: "crop_image", input: { a: 1 } }],
        },
        {
          role: "tool",
          toolCallId: "call_a",
          content: '{"status":"completed"}',
        },
      ],
      tools,
    })) {
      void _;
    }

    const body = lastBody() as {
      tools: unknown[];
      messages: Record<string, unknown>[];
    };

    expect(body.tools).toHaveLength(1);
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "crop_image" } },
      ],
    });
    expect(body.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_a",
    });
  });
});
