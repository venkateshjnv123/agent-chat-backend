import { describe, expect, it } from "vitest";

import { GET as getHealth } from "@/app/api/v1/health/route";
import { HealthResponseSchema } from "@/contracts/service";

describe("GET /api/v1/health", () => {
  it("returns contract-valid service health", async () => {
    const response = getHealth();
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(HealthResponseSchema.safeParse(body).success).toBe(true);
  });
});
