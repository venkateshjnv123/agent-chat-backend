import { z } from "zod";

import {
  GptImage2EditInputSchema,
  GptImage2TextInputSchema,
} from "@/tools/generated/schemas";
import { urlList, type ToolDefinition } from "@/tools/types";

/**
 * `gpt_image_2`, split into the two sub-models the node exposes.
 *
 * They are separate registry entries rather than one tool with a mode flag: a
 * single tool would force the model to guess when `uploadedImages` is required,
 * and the edit path fails at the provider without it. Both dispatch to the same
 * `nodeType` and carry `subModelId` in the request body.
 */

/**
 * Custom dimensions replace the preset rather than accompanying it.
 *
 * The live schema is explicit that a custom size is an object in `size` itself,
 * not a `"Custom"` sentinel with sibling width/height fields — that older shape
 * is what the captured catalogue described, and sending it now fails.
 */
const CustomSizeSchema = z
  .object({
    width: z.number().int().min(1024).max(3840),
    height: z.number().int().min(1024).max(3840),
  })
  .describe(
    "Exact output size. Width and height must each be 1024-3840 and a multiple of 16.",
  )
  .superRefine(({ width, height }, context) => {
    if (width % 16 !== 0 || height % 16 !== 0) {
      context.addIssue({
        code: "custom",
        message: "width and height must be multiples of 16",
      });
    }

    if (Math.max(width, height) / Math.min(width, height) > 3) {
      context.addIssue({
        code: "custom",
        message: "long-to-short ratio must be at most 3:1",
      });
    }

    const pixels = width * height;

    if (pixels < 655_360 || pixels > 8_294_400) {
      context.addIssue({
        code: "custom",
        message: "total pixels must be between 655360 and 8294400",
      });
    }
  });

const PromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .describe("Required image instructions, up to 4000 characters.");

const HttpsUrlSchema = z
  .url()
  .refine((value) => value.startsWith("https://"), "must use HTTPS");

function withCustomSize<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.extend({
    prompt: PromptSchema,
    size: z.union([schema.shape.size as z.ZodTypeAny, CustomSizeSchema]),
  });
}

const textInput = withCustomSize(GptImage2TextInputSchema);
const editInput = withCustomSize(GptImage2EditInputSchema).extend({
  uploadedImages: z.array(HttpsUrlSchema).min(1).max(10),
});

function nodeInput(
  input: Record<string, unknown>,
  subModelId: string,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ),
    subModelId,
  };
}

function imageResult(
  toolName: string,
  output: Record<string, unknown>,
  input: Record<string, unknown> = {},
) {
  const format = input.output_format;
  const mimeType =
    format === "JPEG"
      ? "image/jpeg"
      : format === "WebP"
        ? "image/webp"
        : "image/png";

  return {
    type: "image" as const,
    urls: urlList(toolName, output, "result"),
    width: null,
    height: null,
    mimeType,
  };
}

export const gptImage2Text: ToolDefinition<typeof textInput> = {
  name: "gpt_image_2_text",
  nodeType: "gpt_image_2",
  subModelId: "gpt-image-2-text",
  description:
    "Generate images from a text prompt with GPT Image 2. Use a preset size, " +
    'or pass size as an object like {"width":1024,"height":1024} for exact ' +
    "dimensions. Use this when there is no source image to edit.",
  rendererKey: "image",
  input: textInput,

  toNodeInput(input) {
    return nodeInput(input, "gpt-image-2-text");
  },

  toResult(output, input) {
    return imageResult("gpt_image_2_text", output, input);
  },
};

export const gptImage2Edit: ToolDefinition<typeof editInput> = {
  name: "gpt_image_2_edit",
  nodeType: "gpt_image_2",
  subModelId: "gpt-image-2-edit",
  description:
    "Edit existing images with GPT Image 2. Requires uploadedImages: public " +
    "HTTPS URLs of the source images to edit (up to 10), which may be URLs " +
    "produced by an earlier tool step.",
  rendererKey: "image",
  input: editInput,

  toNodeInput(input) {
    return nodeInput(input, "gpt-image-2-edit");
  },

  toResult(output, input) {
    return imageResult("gpt_image_2_edit", output, input);
  },
};
