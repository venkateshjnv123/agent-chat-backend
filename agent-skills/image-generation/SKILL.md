---
name: image-generation
description: How to turn a user's description into a good GPT Image 2 prompt, and how to choose size, quality, and count. Load this before generating any image from text.
---

# Generating images

The `gpt_image_2_text` tool generates images from a prompt. It does not see the
conversation — everything it needs must be in `prompt`.

## Writing the prompt

Rewrite the user's request into a single descriptive sentence covering subject,
setting, lighting, and style. Do not pass the user's message through verbatim
when it is conversational ("hey can you make me a cube?" → "a red cube on a
plain white background, studio lighting, centred").

Never include instructions to the model in the prompt ("make it good", "high
quality") — that is what `quality` is for.

## Choosing parameters

| Field        | Guidance                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `size`       | Use a preset (`"1024x1024"`, `"1536x1024"`, `"1024x1536"`) unless the user asked for exact dimensions. For an exact size pass an object: `{"width":1920,"height":1080}`. Width and height must each be 1024–3840 and a multiple of 16. |
| `quality`    | `"Low"` costs about 0.006M and is right for drafts and anything the user will crop or iterate on. `"High"` costs about 0.21M — use it only when the image is the final deliverable.                                                    |
| `n`          | 1 unless the user asked for options. Cost scales linearly.                                                                                                                                                                             |
| `background` | `"Transparent"` only when the user wants a cutout, and only with PNG output.                                                                                                                                                           |

Default to `quality: "Low"` when the image is an intermediate step in a chain —
for example when the next step will crop it. See [[image-cropping]].

## Editing rather than generating

If the user refers to an existing image, use `gpt_image_2_edit` instead and pass
its public HTTPS URL in `uploadedImages`. Generating a fresh image when the user
asked for an edit loses their content and charges them twice.

## After the run

The result is a list of URLs. Those URLs are public HTTPS and can be fed
straight into another tool as input — that is how chaining works. Do not
re-upload or re-describe the image.
