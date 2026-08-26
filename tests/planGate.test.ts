import { describe, expect, it } from "vitest";

import {
  callFingerprint,
  needsPlanApproval,
  stableStringify,
} from "@/services/planGate";

/**
 * The rule the gate enforces: credits are never spent on a call the user has
 * not seen priced on an approval card.
 *
 * Two defects motivated these tests. The first was a composer that never asked
 * for plan mode, which made the whole approval path unreachable — so approval
 * must be driven by whether the batch is billable, never by a client flag. The
 * second was approval that latched for the rest of the run, so a chained task
 * ran its second, more expensive step against a card that only described the
 * first.
 */

const CROP = {
  name: "crop_image",
  input: { url: "https://x/a.png", width: 10 },
};

describe("needsPlanApproval", () => {
  it("pauses a billable batch that has not been approved", () => {
    expect(needsPlanApproval([CROP], new Set())).toBe(true);
  });

  it("does not pause a turn that only calls local tools", () => {
    const local = {
      name: "load_skill",
      input: { name: "model-recommendations" },
    };

    expect(needsPlanApproval([local], new Set())).toBe(false);
  });

  it("does not pause when the batch was already approved", () => {
    const approved = new Set([callFingerprint(CROP)]);

    expect(needsPlanApproval([CROP], approved)).toBe(false);
  });

  it("pauses again when a later step uses arguments nobody approved", () => {
    const approved = new Set([callFingerprint(CROP)]);
    const chained = {
      name: "crop_image",
      input: { url: "https://x/generated.png", width: 10 },
    };

    expect(needsPlanApproval([chained], approved)).toBe(true);
  });

  it("pauses a mixed batch for the sake of its one billable call", () => {
    const local = { name: "load_skill", input: {} };

    expect(needsPlanApproval([local, CROP], new Set())).toBe(true);
  });
});

describe("callFingerprint", () => {
  it("ignores property order", () => {
    const a = { name: "crop_image", input: { url: "u", width: 1 } };
    const b = { name: "crop_image", input: { width: 1, url: "u" } };

    expect(callFingerprint(a)).toBe(callFingerprint(b));
  });

  it("separates calls that differ only by argument", () => {
    const a = { name: "crop_image", input: { url: "one" } };
    const b = { name: "crop_image", input: { url: "two" } };

    expect(callFingerprint(a)).not.toBe(callFingerprint(b));
  });

  it("sorts nested keys and preserves array order", () => {
    expect(stableStringify({ b: [2, 1], a: { d: 1, c: 2 } })).toBe(
      '{"a":{"c":2,"d":1},"b":[2,1]}',
    );
  });
});
