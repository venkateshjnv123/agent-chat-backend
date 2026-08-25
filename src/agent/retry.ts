/**
 * Bounded retry for transient provider failures.
 *
 * There is deliberately no fallback model here. When OpenRouter is rate
 * limiting or down, the only options are to wait briefly and try again or to
 * fail visibly; silently switching to a billable model would spend a user's
 * money to hide an outage.
 *
 * The bound matters more than the backoff. An unbounded retry against a
 * provider that is refusing everyone turns one failed turn into a task that
 * occupies a worker until `maxDuration` and then fails anyway, having told the
 * user nothing for five minutes.
 */

/** A failure worth trying again: rate limits, upstream 5xx, network resets. */
export class TransientProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "TransientProviderError";
    this.status = status;
  }
}

/** The provider gave a well-formed refusal. Retrying reproduces it exactly. */
export class PermanentProviderError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PermanentProviderError";
    this.status = status;
  }
}

export type RetryOptions = {
  /** Total attempts including the first. */
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
};

export const DEFAULT_RETRY: Pick<
  RetryOptions,
  "attempts" | "initialDelayMs" | "maxDelayMs"
> = {
  attempts: 3,
  initialDelayMs: 700,
  maxDelayMs: 4_000,
};

/**
 * Decides whether a failure is worth a second attempt.
 *
 * 408/409/429 and every 5xx are the provider saying "not now". 4xx otherwise is
 * the provider saying "not like this", which a retry cannot fix.
 */
export function classifyHttp(status: number, body?: string): Error {
  const message = `openrouter_http_${status}${body ? `: ${body.slice(0, 200)}` : ""}`;

  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return new TransientProviderError(message, status);
  }

  return new PermanentProviderError(message, status);
}

/** A dropped socket or a request timeout is transient; a caller abort is not. */
export function classifyThrown(error: unknown, signal?: AbortSignal): Error {
  if (error instanceof TransientProviderError) return error;
  if (error instanceof PermanentProviderError) return error;

  const thrown = error instanceof Error ? error : new Error(String(error));

  // A stop button is not a failure to retry around — it is the answer.
  if (signal?.aborted) return thrown;

  if (thrown.name === "TimeoutError") {
    return new TransientProviderError("openrouter_timeout");
  }

  if (thrown.name === "AbortError") return thrown;

  // fetch() reports every connection-level problem as a generic TypeError.
  if (thrown instanceof TypeError) {
    return new TransientProviderError(`openrouter_network: ${thrown.message}`);
  }

  return thrown;
}

/**
 * Runs `attempt`, retrying only `TransientProviderError`, with full jitter.
 *
 * Jitter is not decoration. Every turn that hit the same 429 would otherwise
 * come back at the same instant and reproduce the burst that caused it.
 */
export async function withProviderRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;

  let delay = options.initialDelayMs;
  let lastError: Error = new Error("retry_never_ran");

  for (let n = 1; n <= options.attempts; n += 1) {
    try {
      return await attempt(n);
    } catch (error) {
      lastError = classifyThrown(error, options.signal);

      const isLast = n === options.attempts;

      if (!(lastError instanceof TransientProviderError) || isLast) {
        throw lastError;
      }

      const waitMs = Math.round(Math.random() * delay);

      options.onRetry?.({ attempt: n, delayMs: waitMs, error: lastError });

      await sleep(waitMs, options.signal);
      delay = Math.min(delay * 2, options.maxDelayMs);
    }
  }

  throw lastError;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
