---
name: image-cropping
description: How to translate a user's crop request into crop_image percentage or pixel arguments, including the anchor rules. Load this before cropping an image.
---

# Cropping images

`crop_image` takes a public HTTPS `image_url` and cuts a rectangle out of it.
It accepts the source as a URL only — it cannot take an upload, and it cannot
take a data URI.

## Percentages first

`width_percent` and `height_percent` default to 100 and are relative to the
source. Prefer them: they work without knowing the source dimensions, which you
usually do not.

| User says              | Arguments                                                                   |
| ---------------------- | --------------------------------------------------------------------------- |
| "the left half"        | `width_percent: 50`, `x_percent: 0`                                         |
| "the right half"       | `width_percent: 50`, `x_percent: 50`                                        |
| "the top third"        | `height_percent: 33`, `y_percent: 0`                                        |
| "the centre square"    | `width_percent: 60`, `height_percent: 60`, `x_percent: 20`, `y_percent: 20` |
| "crop the borders off" | `width_percent: 90`, `height_percent: 90`, `x_percent: 5`, `y_percent: 5`   |

Use `width_px` / `height_px` only when the user gave an exact pixel size. Mixing
the two is not meaningful — pick one system per call.

## Anchors

`x_percent` and `y_percent` are the top-left corner of the crop window, not its
centre. To centre a crop of width `w`, set `x_percent` to `(100 - w) / 2`.

A crop window that runs past the edge of the source is clamped by the provider,
which silently gives the user a different image than they asked for. Check that
`x_percent + width_percent <= 100` before dispatching.

## Chaining

The common request is "generate something, then crop it". Generate first with
[[image-generation]], take the URL out of that result, and pass it as
`image_url` here. Do not try to do both in one call — they are two tools.

If the user gives you an image URL directly, use it as-is. Do not fetch or
inspect it first; the tool will fail loudly if the URL is unusable.
