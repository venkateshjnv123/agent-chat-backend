import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RETRY,
  PermanentProviderError,
  TransientProviderError,
  classifyHttp,
  classifyThrown,
  withProviderRetry,
} from "@/agent/retry";

/**
 * Bounded backoff around a provider that is refusing requests (PLAN.md 3.1).
 *
 * The behaviour worth pinning down is not that a retry happens — it is which
 * failures are retried and which are not. Retrying a malformed request wastes a
 * user's time reproducing the same error three times, and not retrying a 429
 * turns a momentary rate limit into a failed turn.
 */
const instant = { ...DEFAULT_RETRY, sleep: async () => undefined };

describe("classification", () => {
  it("treats rate limits and upstream 5xx as transient", () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      expect(classifyHttp(status), String(status)).toBeInstanceOf(
        TransientProviderError,
      );
    }
  });

  it("treats a rejected request as permanent", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyHttp(status), String(status)).toBeInstanceOf(
        PermanentProviderError,
      );
    }
  });

  it("keeps the response body out of the message beyond a short prefix", () => {
    const error = classifyHttp(500, "x".repeat(5_000));

    expect(error.message.length).toBeLessThan(260);
  });

  it("reads a dropped socket as transient and a stop as neither", () => {
    expect(classifyThrown(new TypeError("fetch failed"))).toBeInstanceOf(
      TransientProviderError,
    );

    const timeout = new Error("slow");
    timeout.name = "TimeoutError";
    expect(classifyThrown(timeout)).toBeInstanceOf(TransientProviderError);

    // A user pressing stop must not be retried around.
    const controller = new AbortController();
    controller.abort();

    const aborted = new Error("aborted");
    aborted.name = "AbortError";

    expect(classifyThrown(aborted, controller.signal)).not.toBeInstanceOf(
      TransientProviderError,
    );
  });
});

describe("bounded retry", () => {
  it("succeeds on a later attempt without surfacing the earlier failures", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(classifyHttp(429))
      .mockRejectedValueOnce(classifyHttp(503))
      .mockResolvedValue("ok");

    await expect(withProviderRetry(attempt, instant)).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("gives up at the bound rather than retrying forever", async () => {
    const attempt = vi.fn().mockRejectedValue(classifyHttp(429));

    await expect(withProviderRetry(attempt, instant)).rejects.toBeInstanceOf(
      TransientProviderError,
    );
    // An unbounded retry against a provider that is down occupies the worker
    // until maxDuration and then fails anyway, having told the user nothing.
    expect(attempt).toHaveBeenCalledTimes(DEFAULT_RETRY.attempts);
  });

  it("does not retry a request the provider rejected", async () => {
    const attempt = vi.fn().mockRejectedValue(classifyHttp(400));

    await expect(withProviderRetry(attempt, instant)).rejects.toBeInstanceOf(
      PermanentProviderError,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("backs off with jitter inside a growing ceiling", async () => {
    const delays: number[] = [];
    const attempt = vi.fn().mockRejectedValue(classifyHttp(429));

    await withProviderRetry(attempt, {
      attempts: 4,
      initialDelayMs: 100,
      maxDelayMs: 400,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => undefined);

    expect(delays).toHaveLength(3);
    // Full jitter: each wait is somewhere in [0, ceiling], and the ceiling
    // doubles. Without jitter every turn that hit the same 429 would come back
    // at the same instant and reproduce the burst.
    expect(delays[0]).toBeLessThanOrEqual(100);
    expect(delays[1]).toBeLessThanOrEqual(200);
    expect(delays[2]).toBeLessThanOrEqual(400);
    for (const delay of delays) expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("stops retrying once the run is cancelled", async () => {
    const controller = new AbortController();
    const attempt = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new TypeError("fetch failed");
    });

    await expect(
      withProviderRetry(attempt, { ...instant, signal: controller.signal }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
