import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentChunk, AgentProvider } from "@/agent/provider";

const estimateCredits = vi.fn();

vi.mock("@/magica/client", () => ({ estimateCredits }));

const {
  approvedPlanExecutionInstruction,
  buildCompleteExecutionPlan,
  buildPlanFromCalls,
  hasPendingBillablePlanSteps,
  hasPendingPlannedTool,
  markPlanStep,
  planCoversCalls,
  shouldRetryApprovedPlanCall,
} = await import("@/services/executionPlan");
const { PlanPayloadSchema, ResolveWaitpointRequestSchema } =
  await import("@/contracts/waitpoint");

beforeEach(() => {
  estimateCredits.mockResolvedValue([
    { microcredits: 210_720 },
    { microcredits: 5_000 },
  ]);
});

describe("complete execution planning", () => {
  it("persists a dependent generate-to-crop graph before execution", async () => {
    const provider = providerFor({
      title: "Generate and crop",
      overview: "Create an image, then crop its output.",
      notes: "Crop depends on generated image.",
      steps: [
        {
          id: "generate",
          toolName: "gpt_image_2_text",
          title: "Generate image",
          description: "Create the requested source image.",
          dependsOn: [],
          input: {
            prompt: "red square on white background",
            size: "1024x1024",
            quality: "Medium",
            output_format: "PNG",
            background: "Opaque",
          },
        },
        {
          id: "crop",
          toolName: "crop_image",
          title: "Crop image",
          description: "Crop generated output to its left half.",
          dependsOn: ["generate"],
          input: {
            image_url: { $fromStep: "generate", path: "result.urls.0" },
            x_percent: 0,
            y_percent: 0,
            width_percent: 50,
            height_percent: 100,
          },
        },
      ],
    });

    const result = await buildCompleteExecutionPlan({
      provider,
      conversation: [
        { role: "user", content: "Generate red square then crop it" },
      ],
      tools: toolSchemas(),
    });

    expect(result.plan?.steps).toMatchObject([
      {
        id: "step_1",
        n: 1,
        toolName: "gpt_image_2_text",
        dependsOn: [],
        estimateCredits: 210_720,
        status: "PENDING",
      },
      {
        id: "step_2",
        n: 2,
        toolName: "crop_image",
        dependsOn: ["step_1"],
        estimateCredits: 5_000,
        status: "PENDING",
      },
    ]);
    expect(result.plan?.steps[1]?.input).toMatchObject({
      image_url: { $fromStep: "step_1", path: "result.urls.0" },
    });
    expect(result.plan?.totalEstimate).toBe(215_720);

    const cropCall = {
      id: "crop_call",
      name: "crop_image",
      input: {
        image_url: "https://example.com/generated.png",
        x_percent: 0,
        y_percent: 0,
        width_percent: 50,
        height_percent: 100,
      },
    };
    expect(planCoversCalls(result.plan!, [cropCall])).toBe(false);

    const afterGenerate = markPlanStep(
      result.plan!,
      {
        id: "generate_call",
        name: "gpt_image_2_text",
        input: {
          prompt: "red square on white background",
          size: "1024x1024",
          quality: "Medium",
          output_format: "PNG",
          background: "Opaque",
        },
      },
      "COMPLETED",
    );
    expect(planCoversCalls(afterGenerate, [cropCall])).toBe(true);
  });

  it("conservatively adds an already-proposed call omitted by planner", async () => {
    const result = await buildCompleteExecutionPlan({
      provider: providerFor({ steps: [] }),
      conversation: [{ role: "user", content: "crop this" }],
      tools: toolSchemas(),
      initialCalls: [
        {
          id: "call_1",
          name: "crop_image",
          input: {
            image_url: "https://example.com/source.png",
            x_percent: 0,
            y_percent: 0,
            width_percent: 50,
            height_percent: 100,
          },
        },
      ],
    });

    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0]).toMatchObject({
      id: "step_1",
      toolName: "crop_image",
      input: { image_url: "https://example.com/source.png" },
    });
  });

  it("retries one malformed planner response before safe fallback", async () => {
    let attempts = 0;
    const provider: AgentProvider = {
      name: "test",
      async *stream(): AsyncGenerator<AgentChunk> {
        attempts += 1;
        yield {
          type: "text",
          text:
            attempts === 1
              ? "not json"
              : JSON.stringify({
                  steps: [
                    {
                      id: "crop",
                      toolName: "crop_image",
                      title: "Crop image",
                      description: "Crop the supplied image.",
                      dependsOn: [],
                      input: {
                        image_url: "https://example.com/source.png",
                        width_percent: 50,
                      },
                    },
                  ],
                }),
        };
        yield {
          type: "done",
          routedModel: "test/free",
          usage: { inputTokens: 2, outputTokens: 3 },
          toolCalls: [],
          finishReason: "stop",
        };
      },
    };

    const result = await buildCompleteExecutionPlan({
      provider,
      conversation: [{ role: "user", content: "crop this" }],
      tools: toolSchemas(),
    });

    expect(attempts).toBe(2);
    expect(result.plan?.steps[0]?.toolName).toBe("crop_image");
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 6 });
  });

  it("tracks released plan progress by stable tool order", async () => {
    const call = {
      id: "call_1",
      name: "crop_image",
      input: {
        image_url: "https://example.com/a.png",
        x_percent: 0,
        y_percent: 0,
        width_percent: 50,
        height_percent: 100,
      },
    };
    const plan = await buildPlanFromCalls([call]);

    expect(plan).not.toBeNull();
    expect(hasPendingPlannedTool(plan!, "crop_image")).toBe(true);
    expect(planCoversCalls(plan!, [call])).toBe(true);
    expect(
      planCoversCalls(plan!, [
        { ...call, input: { ...call.input, width_percent: 75 } },
      ]),
    ).toBe(false);
    const complete = markPlanStep(plan!, call, "COMPLETED");
    expect(hasPendingPlannedTool(complete, "crop_image")).toBe(false);
    expect(complete.steps[0]?.status).toBe("COMPLETED");
    expect(
      planCoversCalls(plan!, [
        { ...call, id: "1" },
        { ...call, id: "2" },
      ]),
    ).toBe(false);
  });

  it("canonicalizes defaults and retries variations without another approval", async () => {
    const approvedCall = {
      id: "approved_image",
      name: "gpt_image_2_text",
      input: { prompt: "Naruto standing in Gurugram" },
    };
    const plan = await buildPlanFromCalls([approvedCall]);

    expect(plan?.steps[0]?.input).toMatchObject({
      prompt: "Naruto standing in Gurugram",
      size: "Auto",
      quality: "High",
      background: "Auto",
      n: 1,
      output_format: "PNG",
      output_compression: 80,
    });

    const equivalentCall = {
      ...approvedCall,
      id: "model_image",
      input: {
        prompt: "Naruto standing in Gurugram",
        size: "Auto",
        quality: "High",
        background: "Auto",
        n: 1,
        output_format: "PNG",
        output_compression: 80,
      },
    };
    expect(planCoversCalls(plan!, [equivalentCall])).toBe(true);
    expect(shouldRetryApprovedPlanCall(plan!, [equivalentCall])).toBe(false);

    const changedCall = {
      ...equivalentCall,
      input: { ...equivalentCall.input, prompt: "A different image" },
    };
    expect(shouldRetryApprovedPlanCall(plan!, [changedCall])).toBe(true);
    expect(hasPendingBillablePlanSteps(plan!)).toBe(true);
    expect(approvedPlanExecutionInstruction(plan!)).toContain(
      "do not merely describe what you will do",
    );

    const completed = markPlanStep(plan!, equivalentCall, "COMPLETED");
    expect(hasPendingBillablePlanSteps(completed)).toBe(false);
    expect(shouldRetryApprovedPlanCall(completed, [changedCall])).toBe(false);
  });
});

describe("approval contracts", () => {
  it("upgrades historical plan rows for safe reload rendering", () => {
    const parsed = PlanPayloadSchema.parse({
      title: "Legacy plan",
      overview: "One old step",
      steps: [
        {
          n: 1,
          title: "Crop image",
          description: "Crop it.",
          estimateCredits: 5_000,
        },
      ],
      totalEstimate: 5_000,
      notes: null,
    });

    expect(parsed.steps[0]).toMatchObject({
      id: "step_1",
      toolName: "crop_image",
      status: "PENDING",
    });
  });

  it("requires non-empty bounded feedback for REQUEST_CHANGES", () => {
    expect(
      ResolveWaitpointRequestSchema.safeParse({
        resolution: "REQUEST_CHANGES",
        feedback: "   ",
        idempotencyKey: "decision-key-1",
      }).success,
    ).toBe(false);
  });
});

function providerFor(payload: unknown): AgentProvider {
  return {
    name: "test",
    async *stream(): AsyncGenerator<AgentChunk> {
      yield { type: "text", text: JSON.stringify(payload) };
      yield {
        type: "done",
        routedModel: "test/free",
        usage: { inputTokens: 10, outputTokens: 20 },
        toolCalls: [],
        finishReason: "stop",
      };
    },
  };
}

function toolSchemas() {
  return [
    {
      type: "function" as const,
      function: {
        name: "gpt_image_2_text",
        description: "Generate image",
        parameters: {},
      },
    },
    {
      type: "function" as const,
      function: {
        name: "crop_image",
        description: "Crop image",
        parameters: {},
      },
    },
  ];
}
