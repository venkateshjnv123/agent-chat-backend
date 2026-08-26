import { describe, expect, it } from "vitest";

import { readOpenRouterEnv, readServerEnv } from "@/env/server";

const validEnv = {
  DATABASE_URL: "postgresql://user:pass@db.example.test/app",
  DIRECT_URL: "postgresql://user:pass@db.example.test/app",
  CLERK_SECRET_KEY: "clerk-secret",
  CLERK_JWT_ISSUER_DOMAIN: "https://clerk.example.test",
  OPENROUTER_API_KEY: "openrouter-secret",
  OPENROUTER_MODEL: "openrouter/free",
  MAGICA_API_KEY: "magica-secret",
  MAGICA_BASE_URL: "https://inference.magica.example.test",
  TRIGGER_SECRET_KEY: "trigger-secret",
  FRONTEND_ORIGIN: "https://chat.example.test",
};

describe("readServerEnv", () => {
  it("accepts required configuration", () => {
    expect(
      readServerEnv({
        ...validEnv,
        TRANSLOADIT_AUTH_KEY: "",
        TRANSLOADIT_AUTH_SECRET: "",
      }),
    ).toMatchObject({ OPENROUTER_MODEL: "openrouter/free" });
  });

  it("accepts a comma-separated frontend origin allowlist", () => {
    expect(
      readServerEnv({
        ...validEnv,
        FRONTEND_ORIGIN: "https://app.example.test,http://localhost:3000",
      }).FRONTEND_ORIGIN,
    ).toContain(",");
  });

  it("reports invalid field names without values", () => {
    const invalid = { ...validEnv, OPENROUTER_MODEL: "paid/model" };

    expect(() => readServerEnv(invalid)).toThrow(
      "Invalid server environment: OPENROUTER_MODEL",
    );
  });
});

describe("readOpenRouterEnv", () => {
  it("enforces the free routing model at provider call time", () => {
    expect(() =>
      readOpenRouterEnv({
        OPENROUTER_API_KEY: "secret",
        OPENROUTER_MODEL: "paid/model",
      }),
    ).toThrow("Invalid server environment: OPENROUTER_MODEL");
  });
});
