import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ToolResultSchema } from "@/contracts/chat";
import { getTool, listTools, toOpenRouterTools } from "@/tools/registry";

const catalogue = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../reference/api/models.json"),
    "utf8",
  ),
) as {
  nodeType: string;
  inputFieldOptions: { zodExpectedName: string; required?: boolean }[];
  subModels?: {
    subModelId: string;
    inputFieldOptions: { zodExpectedName: string; required?: boolean }[];
  }[];
}[];

function fieldsFor(nodeType: string, subModelId: string | null) {
  const model = catalogue.find((entry) => entry.nodeType === nodeType)!;
  const variant = subModelId
    ? model.subModels!.find((sub) => sub.subModelId === subModelId)!
    : model;

  return variant.inputFieldOptions;
}

describe("tool registry", () => {
  it("exposes the three Phase 1 tools, with gpt_image_2 split by sub-model", () => {
    expect(listTools().map((tool) => tool.name)).toEqual([
      "crop_image",
      "gpt_image_2_text",
      "gpt_image_2_edit",
      "merge_videos",
    ]);
  });

  it("names every input field exactly as the live API expects", () => {
    for (const tool of listTools()) {
      const schema = toOpenRouterTools([tool])[0].function.parameters as {
        properties: Record<string, unknown>;
      };
      const expected = new Set(
        fieldsFor(tool.nodeType, tool.subModelId).map(
          (field) => field.zodExpectedName,
        ),
      );

      for (const key of Object.keys(schema.properties)) {
        expect(expected).toContain(key);
      }
    }
  });

  it("produces OpenRouter tool JSON with a described object schema", () => {
    const tools = toOpenRouterTools();

    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.description.length).toBeGreaterThan(20);
      expect(tool.function.parameters).toMatchObject({ type: "object" });
    }
  });

  it("marks defaulted fields optional so the model may omit them", () => {
    const crop = toOpenRouterTools([getTool("crop_image")!])[0].function
      .parameters as { required?: string[] };

    expect(crop.required).toEqual(["image_url"]);
  });

  it("requires uploadedImages on the edit sub-model only", () => {
    const edit = toOpenRouterTools([getTool("gpt_image_2_edit")!])[0].function
      .parameters as { required?: string[] };
    const text = toOpenRouterTools([getTool("gpt_image_2_text")!])[0].function
      .parameters as { required?: string[] };

    expect(edit.required).toContain("uploadedImages");
    expect(text.required ?? []).not.toContain("uploadedImages");
  });
});

describe("tool input validation", () => {
  it("rejects a merge of fewer than two videos", () => {
    const tool = getTool("merge_videos")!;

    expect(
      tool.input.safeParse({ video_urls: ["https://x.test/a.mp4"] }).success,
    ).toBe(false);
    expect(
      tool.input.safeParse({
        video_urls: ["https://x.test/a.mp4", "https://x.test/b.mp4"],
      }).success,
    ).toBe(true);
  });

  it("takes a custom size as an object, not a Custom sentinel", () => {
    const tool = getTool("gpt_image_2_text")!;

    // The live schema dropped the "Custom" preset; sending it now fails.
    expect(
      tool.input.safeParse({ prompt: "a red cube", size: "Custom" }).success,
    ).toBe(false);
    expect(
      tool.input.safeParse({
        prompt: "a red cube",
        size: { width: 1024, height: 1024 },
      }).success,
    ).toBe(true);
    expect(
      tool.input.safeParse({ prompt: "a red cube", size: "1024x1024" }).success,
    ).toBe(true);
    expect(tool.input.safeParse({ prompt: "a red cube" }).success).toBe(true);
  });
});

describe("node input mapping", () => {
  it("sends subModelId alongside the mapped input", () => {
    const tool = getTool("gpt_image_2_text")!;
    const parsed = tool.input.parse({
      prompt: "a red cube",
      size: "1024x1024",
    }) as Record<string, unknown>;

    const body = tool.toNodeInput(parsed);

    expect(body.subModelId).toBe("gpt-image-2-text");
    expect(body.prompt).toBe("a red cube");
    expect(body.size).toBe("1024x1024");
  });

  it("omits unset optional crop fields rather than sending nulls", () => {
    const tool = getTool("crop_image")!;
    const parsed = tool.input.parse({
      image_url: "https://x.test/a.png",
    }) as Record<string, unknown>;

    const body = tool.toNodeInput(parsed);

    expect(body).not.toHaveProperty("width_px");
    expect(body.width_percent).toBe(100);
  });
});

describe("result mapping", () => {
  it("maps crop output onto the image result the renderer expects", () => {
    const result = getTool("crop_image")!.toResult({
      image_url: "https://x.test/out.png",
      width: 768,
      height: 512,
      creditUsed: 5000,
    });

    expect(ToolResultSchema.parse(result)).toEqual({
      type: "image",
      urls: ["https://x.test/out.png"],
      width: 768,
      height: 512,
      mimeType: "image/png",
    });
  });

  it("maps a merged video and a multi-image generation", () => {
    expect(
      getTool("merge_videos")!.toResult({
        video_url: ["https://x.test/merged.mp4"],
      }),
    ).toMatchObject({ type: "video", urls: ["https://x.test/merged.mp4"] });

    expect(
      getTool("gpt_image_2_text")!.toResult({
        result: ["https://x.test/1.png", "https://x.test/2.png"],
      }),
    ).toMatchObject({ type: "image", urls: expect.any(Array) });
  });

  it("fails loudly when the provider returns no usable URL", () => {
    expect(() => getTool("crop_image")!.toResult({ image_url: null })).toThrow(
      /image_url/,
    );
  });
});
