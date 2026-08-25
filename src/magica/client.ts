import { readRequiredEnv } from "@/env/server";

/**
 * Magica node API client.
 *
 * Every request carries the API key, so the key is read at the point of use and
 * never interpolated into anything that can be logged: `logRequest` records
 * method, path, status and duration only. Request bodies are excluded outright
 * because tool input carries user prompts and signed asset URLs.
 *
 * Endpoints captured in reference/api/capture-api.json:
 *   POST /v1/nodes/estimate-credits   batched, positional
 *   POST /v1/nodes/{nodeType}/run     202 { runId, triggerRunId }
 *   GET  /v1/nodes/runs/{runId}       poll to a terminal status
 *   GET  /v1/credits/balance          integer microcredits
 */

export type MagicaRunStatus =
  "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type MagicaDispatch = {
  runId: string;
  triggerRunId: string | null;
};

export type MagicaRun = {
  id: string;
  nodeType: string;
  subModelId: string | null;
  status: MagicaRunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  /** Internal detail. Never crosses our API boundary. */
  error: string | null;
  /** User-safe copy supplied by the provider. */
  userMessage: string | null;
  creditUsed: number;
  triggerRunId: string | null;
  createdAt: string;
};

export type MagicaEstimate = { microcredits: number };

export type EstimateNode = {
  type: string;
  data: Record<string, unknown>;
};

/**
 * A failed Magica call, carrying the provider's own split between internal
 * detail and user-safe copy so ToolInvocation can persist both (PLAN.md 1.9).
 */
export class MagicaError extends Error {
  readonly status: number;
  readonly code: string;
  readonly userMessage: string;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    userMessage: string;
  }) {
    super(options.message);
    this.name = "MagicaError";
    this.status = options.status;
    this.code = options.code;
    this.userMessage = options.userMessage;
  }
}

const TERMINAL: ReadonlySet<MagicaRunStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export function isTerminal(status: MagicaRunStatus): boolean {
  return TERMINAL.has(status);
}

function credentials() {
  const { MAGICA_API_KEY, MAGICA_BASE_URL } = readRequiredEnv([
    "MAGICA_API_KEY",
    "MAGICA_BASE_URL",
  ]);

  return { key: MAGICA_API_KEY, baseUrl: MAGICA_BASE_URL.replace(/\/+$/, "") };
}

/** Path, status and duration only. Never headers, body or response payload. */
function logRequest(
  method: string,
  path: string,
  status: number,
  startedAt: number,
) {
  console.info(
    `[magica] ${method} ${path} ${status} ${Date.now() - startedAt}ms`,
  );
}

async function request<T>(options: {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const { key, baseUrl } = credentials();
  const startedAt = Date.now();

  const response = await fetch(`${baseUrl}${options.path}`, {
    method: options.method,
    signal: options.signal,
    headers: {
      authorization: `Bearer ${key}`,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  logRequest(options.method, options.path, response.status, startedAt);

  if (!response.ok) {
    throw await toMagicaError(response);
  }

  return (await response.json()) as T;
}

/**
 * Maps a provider failure onto our two-field error model.
 *
 * The route can return non-JSON (the cancel path returns a Next.js HTML 404),
 * so parsing is defensive and falls back to the status code.
 */
async function toMagicaError(response: Response): Promise<MagicaError> {
  let code = `magica_http_${response.status}`;
  let message = code;

  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      error?: string;
    };

    if (body.code) code = body.code;
    if (body.message ?? body.error) message = (body.message ?? body.error)!;
  } catch {
    // Non-JSON body. The status alone is the whole signal.
  }

  return new MagicaError({
    status: response.status,
    code,
    message,
    userMessage: userMessageFor(response.status),
  });
}

function userMessageFor(status: number): string {
  if (status === 400) return "That request wasn't valid for this tool.";
  if (status === 401 || status === 403)
    return "The media provider rejected our credentials.";
  if (status === 404) return "That tool isn't available.";
  if (status === 429) return "The media provider is rate limiting us.";
  return "The media provider couldn't complete this step.";
}

/**
 * Batched credit estimate.
 *
 * The response is positional — `estimates[i]` belongs to `nodes[i]` with no id
 * to match on — so the array length is checked before any caller indexes into
 * it. Invalid input does not error; it returns the base estimate.
 */
export async function estimateCredits(
  nodes: EstimateNode[],
  signal?: AbortSignal,
): Promise<MagicaEstimate[]> {
  if (nodes.length === 0) return [];

  const body = await request<{ estimates?: MagicaEstimate[] }>({
    method: "POST",
    path: "/v1/nodes/estimate-credits",
    body: { nodes },
    signal,
  });

  const estimates = body.estimates ?? [];

  if (estimates.length !== nodes.length) {
    throw new MagicaError({
      status: 502,
      code: "magica_estimate_length_mismatch",
      message: `estimate count ${estimates.length} != node count ${nodes.length}`,
      userMessage: "We couldn't price this step.",
    });
  }

  return estimates;
}

/** Dispatches one node run. Credits are debited at dispatch, not completion. */
export async function dispatchNodeRun(options: {
  nodeType: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<MagicaDispatch> {
  const body = await request<{ runId: string; triggerRunId?: string }>({
    method: "POST",
    path: `/v1/nodes/${encodeURIComponent(options.nodeType)}/run`,
    body: { input: options.input },
    signal: options.signal,
  });

  return { runId: body.runId, triggerRunId: body.triggerRunId ?? null };
}

export async function getNodeRun(
  runId: string,
  signal?: AbortSignal,
): Promise<MagicaRun> {
  return request<MagicaRun>({
    method: "GET",
    path: `/v1/nodes/runs/${encodeURIComponent(runId)}`,
    signal,
  });
}

export async function getCreditBalance(signal?: AbortSignal) {
  return request<{
    availableBalance: number;
    formatted: string;
    hasActiveSubscription: boolean;
    isOrganization: boolean;
  }>({ method: "GET", path: "/v1/credits/balance", signal });
}
