import { describe, expect, it } from "vitest";

import { readJsonBody } from "@/http/body";

describe("readJsonBody", () => {
  it("returns valid JSON", async () => {
    const request = new Request("https://api.example.test", {
      method: "POST",
      body: '{"ok":true}',
    });

    await expect(readJsonBody(request)).resolves.toEqual({ ok: true });
  });

  it("turns malformed JSON into schema-invalid input", async () => {
    const request = new Request("https://api.example.test", {
      method: "POST",
      body: "{broken",
    });

    await expect(readJsonBody(request)).resolves.toBeUndefined();
  });
});
