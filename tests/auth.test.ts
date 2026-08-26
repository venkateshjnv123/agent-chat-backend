import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyToken = vi.fn();

vi.mock("@clerk/backend", () => ({ verifyToken }));

const { verifyRequest } = await import("@/auth/verifyClerkToken");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CLERK_SECRET_KEY = "secret";
  process.env.CLERK_JWT_ISSUER_DOMAIN =
    "https://trusted-instance.clerk.accounts.dev";
  process.env.FRONTEND_ORIGIN =
    "https://app.example.test,http://localhost:3000";
});

function request(token = "session-token") {
  return new Request("https://api.example.test", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("Clerk token verification", () => {
  it("uses the frontend allowlist as authorized parties", async () => {
    verifyToken.mockResolvedValue({
      sub: "user_1",
      iss: "https://trusted-instance.clerk.accounts.dev/",
    });

    await expect(verifyRequest(request())).resolves.toEqual({
      clerkUserId: "user_1",
    });
    expect(verifyToken).toHaveBeenCalledWith(
      "session-token",
      expect.objectContaining({
        secretKey: "secret",
        authorizedParties: [
          "https://app.example.test",
          "http://localhost:3000",
        ],
      }),
    );
  });

  it("rejects issuer prefix and suffix lookalikes", async () => {
    for (const iss of [
      "https://trusted-instance.clerk.accounts.dev.attacker.test",
      "https://attacker.test/trusted-instance.clerk.accounts.dev",
    ]) {
      verifyToken.mockResolvedValueOnce({ sub: "user_1", iss });

      await expect(verifyRequest(request())).resolves.toBeNull();
    }
  });

  it("returns null for a verification failure or missing bearer token", async () => {
    verifyToken.mockRejectedValueOnce(new Error("forged"));

    await expect(verifyRequest(request())).resolves.toBeNull();
    await expect(
      verifyRequest(new Request("https://api.example.test")),
    ).resolves.toBeNull();
  });
});
