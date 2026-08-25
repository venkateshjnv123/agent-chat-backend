import { CropImageInputSchema } from "@/tools/generated/schemas";
import { optionalInt, urlList, type ToolDefinition } from "@/tools/types";

/**
 * `crop_image` — percentage crop, with an optional exact-pixel branch.
 *
 * Percentages are the default path because the model rarely knows the source
 * dimensions; the pixel fields exist for the "crop to exactly 512x512" ask.
 */
export const cropImage: ToolDefinition<typeof CropImageInputSchema> = {
  name: "crop_image",
  nodeType: "crop_image",
  subModelId: null,
  description:
    "Crop an image to a region. Give x/y/width/height as percentages of the " +
    "source image, or width_px/height_px for an exact pixel crop (centred " +
    "unless x_px/y_px are given). Returns the cropped image.",
  rendererKey: "image",
  input: CropImageInputSchema,

  toNodeInput(input) {
    // Undefined optional fields are dropped rather than sent as null: the node
    // treats a present null as "crop to nothing".
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
  },

  toResult(output) {
    return {
      type: "image",
      urls: urlList("crop_image", output, "image_url"),
      width: optionalInt(output, "width"),
      height: optionalInt(output, "height"),
      mimeType: "image/png",
    };
  },
};
