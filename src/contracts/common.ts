import { z } from "zod";

/**
 * Uniform error envelope, mirroring the reference product.
 *
 * Validation detail is deliberately redacted: issues carry only a code and the
 * depth of the failing path, never field names or submitted values. See
 * REFERENCE_FINDINGS.md §16.4.
 */
export const ErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INSUFFICIENT_CREDITS",
  "INTERNAL",
]);

export const ValidationIssueSchema = z.object({
  code: z.string(),
  pathDepth: z.number().int().nonnegative(),
});

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  code: ErrorCodeSchema,
  details: z
    .object({
      issueCount: z.number().int().nonnegative(),
      issues: z.array(ValidationIssueSchema),
    })
    .optional(),
  traceId: z.string(),
});

/** Cursor pagination envelope. Cursors are opaque to the client. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
}

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
