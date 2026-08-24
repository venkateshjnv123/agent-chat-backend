import { describe, expect, it } from "vitest";

import { formatCredits, formatEstimate } from "@/services/credits";

describe("credit formatting", () => {
  it("renders a balance the way the reference product does", () => {
    expect(formatCredits(23_831_516)).toBe("23.83");
    expect(formatCredits(5_000_000)).toBe("5.00");
  });

  it("renders per-step estimates at four decimals", () => {
    // crop_image costs 5000 microcredits and displays as ~0.0050M.
    expect(formatEstimate(5_000)).toBe("~0.0050M");
    expect(formatEstimate(5_607_900)).toBe("~5.6079M");
  });
});
