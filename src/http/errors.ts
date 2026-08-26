import { randomUUID } from "node:crypto";

import type { ZodError } from "zod";

import { ErrorResponseSchema, type ErrorCode } from "@/contracts/common";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INSUFFICIENT_CREDITS: 402,
  INTERNAL: 500,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  UNAUTHORIZED: "Authentication required",
  FORBIDDEN: "Not allowed",
  BAD_REQUEST: "Invalid request.",
  NOT_FOUND: "Not found",
  CONFLICT: "A run is already active for this chat",
  RATE_LIMITED: "Too many requests",
  INSUFFICIENT_CREDITS: "Not enough credits to start this run",
  INTERNAL: "Something went wrong",
};

export function traceId(): string {
  return randomUUID();
}

/**
 * Uniform error envelope. Every route returns this shape so the client has one
 * error path to render. `traceId` is echoed in the response headers and written
 * to structured logs, which is how a UI-visible failure is traced to a run.
 */
export function errorResponse(
  code: ErrorCode,
  options: {
    message?: string;
    issues?: ZodError["issues"];
    trace?: string;
    headers?: Record<string, string>;
  } = {},
): Response {
  const trace = options.trace ?? traceId();
  const message = options.message ?? DEFAULT_MESSAGE[code];

  const body = ErrorResponseSchema.parse({
    error: message,
    message,
    code,
    // Validation detail is redacted to a code and a path depth. Field names and
    // submitted values never leave the server. See REFERENCE_FINDINGS.md §16.4.
    details: options.issues
      ? {
          issueCount: options.issues.length,
          issues: options.issues.map((issue) => ({
            code: issue.code,
            pathDepth: issue.path.length,
          })),
        }
      : undefined,
    traceId: trace,
  });

  return Response.json(body, {
    status: STATUS_BY_CODE[code],
    headers: { ...baseHeaders(trace), ...options.headers },
  });
}

export function jsonResponse<T>(
  body: T,
  init: { status?: number; trace?: string } = {},
): Response {
  const trace = init.trace ?? traceId();

  return Response.json(body, {
    status: init.status ?? 200,
    headers: baseHeaders(trace),
  });
}

function baseHeaders(trace: string): Record<string, string> {
  return {
    "cache-control": "no-store, must-revalidate",
    "x-request-id": trace,
    "x-trace-id": trace,
  };
}
