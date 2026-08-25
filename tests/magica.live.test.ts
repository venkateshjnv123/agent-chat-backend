import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import {
  dispatchNodeRun,
  estimateCredits,
  getCreditBalance,
  getNodeRun,
  isTerminal,
} from "@/magica/client";
import { getTool } from "@/tools/registry";

/**
 * Live Magica calls. Skipped unless MAGICA_LIVE=1, because they spend credits.
 *
 * These exist to prove the wire contract against the real service — the shape
 * of `output`, the positional estimate, and the fact that `/v1` (API key) is a
 * different surface from the `/app/v1` paths the browser capture recorded.
 */
const live = process.env.MAGICA_LIVE === "1";
const SOURCE =
  "https://galaxy-prod.tlcdn.com/gen/ddbfd965af6d477ba31fddb865fd85ce.png";

beforeAll(() => {
  if (!live) return;

  const env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, ""),
      ]),
  );

  Object.assign(process.env, env);
});

describe.skipIf(!live)("magica live", () => {
  it("reads a balance in integer microcredits", async () => {
    const balance = await getCreditBalance();

    expect(Number.isInteger(balance.availableBalance)).toBe(true);
  });

  it("prices a crop and then runs it end to end", async () => {
    const tool = getTool("crop_image")!;
    const input = tool.input.parse({
      image_url: SOURCE,
      x_percent: 10,
      y_percent: 10,
      width_percent: 50,
      height_percent: 50,
    });
    const body = tool.toNodeInput(input);

    const [estimate] = await estimateCredits([
      { type: tool.nodeType, data: body },
    ]);
    expect(estimate.microcredits).toBeGreaterThan(0);

    const dispatch = await dispatchNodeRun({
      nodeType: tool.nodeType,
      input: body,
    });
    expect(dispatch.runId).toBeTruthy();

    let run = await getNodeRun(dispatch.runId);

    for (let attempt = 0; attempt < 40 && !isTerminal(run.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      run = await getNodeRun(dispatch.runId);
    }

    console.info("live crop run", {
      status: run.status,
      creditUsed: run.creditUsed,
      output: run.output,
    });

    expect(run.status).toBe("COMPLETED");
    expect(tool.toResult(run.output ?? {})).toMatchObject({ type: "image" });
  }, 120_000);

  /**
   * The Gate 1 chain, at the API level: a generated image URL is the input to
   * the next tool. This is what makes a tool usable without an uploader.
   */
  it("generates an image and crops the generated URL", async () => {
    const generate = getTool("gpt_image_2_text")!;
    const generateInput = generate.input.parse({
      prompt: "a plain red cube on a white background",
      size: "1024x1024",
      quality: "Low",
    });

    const generated = await runToCompletion(
      generate.nodeType,
      generate.toNodeInput(generateInput),
    );

    const image = generate.toResult(generated.output ?? {});
    expect(image.type).toBe("image");

    const url = "urls" in image ? image.urls[0] : "";
    expect(url).toMatch(/^https:\/\//);

    const crop = getTool("crop_image")!;
    const cropped = await runToCompletion(
      crop.nodeType,
      crop.toNodeInput(
        crop.input.parse({
          image_url: url,
          x_percent: 0,
          y_percent: 0,
          width_percent: 50,
          height_percent: 100,
        }),
      ),
    );

    expect(crop.toResult(cropped.output ?? {})).toMatchObject({
      type: "image",
    });
  }, 300_000);

  it("merges two videos in the order given", async () => {
    const tool = getTool("merge_videos")!;
    const run = await runToCompletion(
      tool.nodeType,
      tool.toNodeInput(
        tool.input.parse({
          video_urls: [
            "https://g.tlcdn.com/view/65f51dc27267481e9f923af5ae96bb6e.mp4",
            "https://g.tlcdn.com/view/df12c91f8b6440f998e5def1e760f0c7.mp4",
          ],
          transition: "fade",
        }),
      ),
    );

    expect(tool.toResult(run.output ?? {})).toMatchObject({ type: "video" });
  }, 600_000);
});

/** Dispatch, then poll to terminal. */
async function runToCompletion(
  nodeType: string,
  input: Record<string, unknown>,
) {
  const dispatch = await dispatchNodeRun({ nodeType, input });

  let run = await getNodeRun(dispatch.runId);

  for (let attempt = 0; attempt < 90 && !isTerminal(run.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    run = await getNodeRun(dispatch.runId);
  }

  if (run.status !== "COMPLETED") {
    throw new Error(`${nodeType} ended ${run.status}: ${run.error ?? "?"}`);
  }

  return run;
}
