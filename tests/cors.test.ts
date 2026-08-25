import { afterEach, describe, expect, it } from "vitest";

import { corsHeaders } from "@/http/cors";

const originalFrontendOrigin = process.env.FRONTEND_ORIGIN;

afterEach(() => {
  if (originalFrontendOrigin === undefined) {
    delete process.env.FRONTEND_ORIGIN;
  } else {
    process.env.FRONTEND_ORIGIN = originalFrontendOrigin;
  }
});

describe("corsHeaders", () => {
  it("allows the idempotency header required by message sends", () => {
    process.env.FRONTEND_ORIGIN = "http://localhost:3000";

    const headers = corsHeaders("http://localhost:3000");

    expect(headers["access-control-allow-headers"]?.split(",")).toContain(
      "idempotency-key",
    );
  });

  it("returns no CORS headers for an untrusted origin", () => {
    process.env.FRONTEND_ORIGIN = "http://localhost:3000";

    expect(corsHeaders("https://attacker.example")).toEqual({});
  });
});
