import { MergeVideosInputSchema } from "@/tools/generated/schemas";
import { urlList, type ToolDefinition } from "@/tools/types";

/**
 * `merge_videos` — concatenation in the order given.
 *
 * The catalogue caps the list at 100 but records the two-video minimum only in
 * help text, so it is enforced here: a one-video merge is a wasted charge.
 */
const input = MergeVideosInputSchema.extend({
  video_urls: MergeVideosInputSchema.shape.video_urls.min(2),
});

export const mergeVideos: ToolDefinition<typeof input> = {
  name: "merge_videos",
  nodeType: "merge_videos",
  subModelId: null,
  description:
    "Concatenate 2-100 videos into one, in the order given. video_urls may be " +
    "URLs produced by an earlier tool step. Optionally apply a transition " +
    "between clips.",
  rendererKey: "video",
  input,

  toNodeInput(value) {
    return { ...value };
  },

  toResult(output) {
    return {
      type: "video",
      urls: urlList("merge_videos", output, "video_url"),
      durationSeconds: null,
      mimeType: "video/mp4",
    };
  },
};
