/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: GET {MAGICA_BASE_URL}/v1/models/{modelId}/schema (live).
 * Regenerate with `pnpm tools:generate`; CI runs `pnpm tools:check`.
 *
 * Property keys are wire names (`zodExpectedName`) and must stay that way:
 * the live API rejects renamed fields with a redacted 400.
 */

import { z } from "zod";

/** `crop_image` — Crop an image to specified dimensions */
export const CropImageInputSchema = z.object({
  image_url: z
    .url()
    .describe(
      "Upload an image to crop — Use public HTTPS URLs only. If the harness gives a local path like /mnt/user-data/uploads/... or file://..., call upload_file first and use the returned permanent URL.",
    ),
  x_percent: z
    .number()
    .min(0)
    .max(100)
    .describe("Horizontal crop start position (percentage from left)")
    .default(0),
  y_percent: z
    .number()
    .min(0)
    .max(100)
    .describe("Vertical crop start position (percentage from top)")
    .default(0),
  width_percent: z
    .number()
    .min(0)
    .max(100)
    .describe("Crop width as a percentage of the original image")
    .default(100),
  height_percent: z
    .number()
    .min(0)
    .max(100)
    .describe("Crop height as a percentage of the original image")
    .default(100),
  width_px: z
    .number()
    .min(1)
    .describe(
      "Exact crop width in pixels. When width and height are set without X/Y, the crop is centered.",
    )
    .optional(),
  height_px: z
    .number()
    .min(1)
    .describe(
      "Exact crop height in pixels. When width and height are set without X/Y, the crop is centered.",
    )
    .optional(),
  x_px: z
    .number()
    .min(0)
    .describe(
      "Optional exact crop start position from the left. Leave empty to center pixel crops.",
    )
    .optional(),
  y_px: z
    .number()
    .min(0)
    .describe(
      "Optional exact crop start position from the top. Leave empty to center pixel crops.",
    )
    .optional(),
});

/** `merge_videos` — Concatenate multiple videos into one */
export const MergeVideosInputSchema = z.object({
  video_urls: z
    .array(z.url())
    .max(100)
    .describe(
      "Upload 2–100 videos to concatenate (in order). — Use public HTTPS URLs only. If the harness gives a local path like /mnt/user-data/uploads/... or file://..., call upload_file first and use the returned permanent URL.",
    ),
  transition: z
    .enum(["none", "fade", "dissolve"])
    .describe("Transition effect between videos")
    .default("none"),
});

/** `gpt-image-2-text` — OpenAI's newest image model with any-resolution support and improved quality */
export const GptImage2TextInputSchema = z.object({
  prompt: z
    .string()
    .max(4000)
    .describe(
      "Text prompt describing the image to generate, max 4000 characters, required",
    ),
  size: z
    .enum([
      "Auto",
      "1024x1024",
      "1536x1024",
      "1024x1536",
      "2048x2048",
      "2048x1152",
      "3840x2160",
      "2160x3840",
    ])
    .describe(
      'Output image dimensions with default Auto. Pick a preset or choose Custom to enter width x height. Custom size: width and height must each be 1024-3840 px, multiples of 16; long-to-short ratio <= 3:1; total pixels 655,360-8,294,400. Prefer a preset unless exact dimensions are required. For 1080p aspect output, use 1920x1088 or 1088x1920; do not use 1920x1080 because 1080 is not a multiple of 16. — For a custom value, do NOT pass "Custom" — instead set "size" directly to an object with numeric "width" and "height", e.g. {"width":1024,"height":1024}. Constraints: Custom size: width and height must each be 1024-3840 px, multiples of 16; long-to-short ratio <= 3:1; total pixels 655,360-8,294,400.',
    )
    .default("Auto"),
  quality: z
    .enum(["High", "Medium", "Low"])
    .describe(
      "Rendering quality level affecting detail and cost with default High, options are High, Medium, Low",
    )
    .default("High"),
  background: z
    .enum(["Auto", "Opaque"])
    .describe(
      "Background mode for the output image with default Auto, options are Auto, Opaque",
    )
    .default("Auto"),
  n: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .describe(
      "Number of images to generate with default 1, options are 1, 2, 3, 4",
    )
    .default(1),
  output_format: z
    .enum(["PNG", "JPEG", "WebP"])
    .describe(
      "Output file format of the generated image with default PNG, options are PNG, JPEG, WebP.",
    )
    .default("PNG"),
  output_compression: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "Compression level controlling file size vs quality tradeoff with default 80, min 0, max 100, step 1. Lower values produce smaller files with less quality — Compression level (0-100). Lower = smaller file, less quality",
    )
    .default(80),
});

/** `gpt-image-2-edit` — OpenAI's newest image model for editing with any-resolution support and improved quality */
export const GptImage2EditInputSchema = z.object({
  prompt: z
    .string()
    .max(4000)
    .describe(
      "Text prompt describing how to edit the image, max 4000 characters, required",
    ),
  uploadedImages: z
    .array(z.url())
    .max(10)
    .describe(
      "Source images to edit, accepts up to 10 image uploads, required — Upload images to edit (max 10 images) — Use public HTTPS URLs only. If the harness gives a local path like /mnt/user-data/uploads/... or file://..., call upload_file first and use the returned permanent URL.",
    ),
  size: z
    .enum([
      "Auto",
      "1024x1024",
      "1536x1024",
      "1024x1536",
      "2048x2048",
      "2048x1152",
      "3840x2160",
      "2160x3840",
    ])
    .describe(
      'Output image dimensions with default Auto. Pick a preset or choose Custom to enter width x height. Custom size: width and height must each be 1024-3840 px, multiples of 16; long-to-short ratio <= 3:1; total pixels 655,360-8,294,400. Prefer a preset unless exact dimensions are required. For 1080p aspect output, use 1920x1088 or 1088x1920; do not use 1920x1080 because 1080 is not a multiple of 16. — For a custom value, do NOT pass "Custom" — instead set "size" directly to an object with numeric "width" and "height", e.g. {"width":1024,"height":1024}. Constraints: Custom size: width and height must each be 1024-3840 px, multiples of 16; long-to-short ratio <= 3:1; total pixels 655,360-8,294,400.',
    )
    .default("Auto"),
  quality: z
    .enum(["High", "Medium", "Low"])
    .describe(
      "Rendering quality level affecting detail and cost with default High, options are High, Medium, Low",
    )
    .default("High"),
  background: z
    .enum(["Auto", "Opaque"])
    .describe(
      "Background transparency mode for the output image with default Auto, options are Auto, Opaque",
    )
    .default("Auto"),
  n: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .describe(
      "Number of images to generate with default 1, options are 1, 2, 3, 4",
    )
    .default(1),
  output_format: z
    .enum(["PNG", "JPEG", "WebP"])
    .describe(
      "Output file format of the generated image with default PNG, options are PNG, JPEG, WebP.",
    )
    .default("PNG"),
  output_compression: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "Compression level controlling file size vs quality tradeoff with default 80, min 0, max 100, step 1. Lower values produce smaller files with less quality — Compression level (0-100). Lower = smaller file, less quality",
    )
    .default(80),
});
