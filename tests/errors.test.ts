import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ErrorResponseSchema } from "@/contracts/common";
import { errorResponse } from "@/http/errors";

describe("error envelope", () => {
  it("returns the documented status for each code", async () => {
    const unauthorized = errorResponse("UNAUTHORIZED");
    const conflict = errorResponse("CONFLICT");

    expect(unauthorized.status).toBe(401);
    expect(conflict.status).toBe(409);

    const body = await unauthorized.json();
    expect(() => ErrorResponseSchema.parse(body)).not.toThrow();
    expect(body.message).toBe("Authentication required");
  });

  it("redacts validation issues to a code and a path depth", async () => {
    const parsed = z
      .object({ image_url: z.string(), x_percent: z.number().max(100) })
      .safeParse({ image_url: 42, x_percent: 500 });

    if (parsed.success) throw new Error("expected the fixture input to fail");

    const body = await errorResponse("BAD_REQUEST", {
      issues: parsed.error.issues,
    }).json();

    expect(body.details.issueCount).toBe(2);
    expect(body.details.issues).toEqual([
      { code: "invalid_type", pathDepth: 1 },
      { code: "too_big", pathDepth: 1 },
    ]);

    // No field name or submitted value may appear anywhere in the payload.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("image_url");
    expect(serialised).not.toContain("500");
  });

  it("echoes a trace id into the body and the headers", async () => {
    const response = errorResponse("INTERNAL", { trace: "trace-abc" });
    const body = await response.json();

    expect(body.traceId).toBe("trace-abc");
    expect(response.headers.get("x-trace-id")).toBe("trace-abc");
    expect(response.headers.get("cache-control")).toBe(
      "no-store, must-revalidate",
    );
  });
});
