---
name: video-merging
description: How to order clips, choose a transition, and set expectations for merge_videos, which is slow and comparatively expensive. Load this before merging video.
---

# Merging videos

`merge_videos` concatenates 2 to 100 clips from public HTTPS URLs into one file.

## Order matters and is not inferred

`video_urls` is played in array order. The provider does not sort, dedupe, or
inspect the clips. If the user listed them in a message, keep their order. If
they described an order ("put the sunset one last"), reorder to match and say
what order you used in your reply — a wrong order is invisible until the user
watches the whole output.

## Transitions

`transition` defaults to a hard cut. `"Fade"` is the safe choice when the clips
are unrelated. Do not add a transition the user did not ask for when the clips
are a continuous take — it reads as a mistake.

## Set expectations before dispatching

This tool is slow and comparatively expensive:

- A two-clip merge takes roughly **two minutes**. Tell the user before you call
  it, so a long silence does not look like a hang.
- It costs around 0.05M, an order of magnitude more than a crop.

Because of both, do not call it speculatively. If the user's request is
ambiguous about which clips or what order, ask first — a wrong merge costs a
full re-run.

## Failure modes worth pre-empting

- Fewer than two URLs is rejected before dispatch. If the user gave one clip,
  ask for the second rather than calling the tool.
- Clips with different resolutions are re-encoded to the first clip's
  dimensions. Mention this if the user supplied an obvious mismatch.
- The result is a single URL in `video_url`, which can be fed into another tool
  the same way an image URL can.
