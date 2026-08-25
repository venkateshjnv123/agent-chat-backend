import { z } from "zod";

/**
 * Plan approval — the reference product's core turn loop.
 *
 * A multi-step run pauses, shows its plan with a per-step credit estimate, and
 * waits for a human. Contracts are published in Phase 0 so the frontend can
 * build the card; the backend implementation lands in Phase 2.
 */

export const WaitpointTypeSchema = z.literal("PLAN_APPROVAL");

export const WaitpointStatusSchema = z.enum([
  "PENDING",
  "RESOLVED",
  "EXPIRED",
  "CANCELLED",
]);

/**
 * `STEP_BY_STEP` is shipped only if Phase 2 completes early.
 * `supportedResolutions` on the waitpoint tells the client which buttons to
 * render, so an unsupported action is hidden rather than shown and then
 * silently downgraded.
 */
export const PlanResolutionSchema = z.enum([
  "RUN_ALL",
  "STEP_BY_STEP",
  "REQUEST_CHANGES",
]);

export const PlanStepSchema = z.object({
  n: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  /** Microcredits, from the batched estimate call. Renders as `~X.XXXXM`. */
  estimateCredits: z.number().int().nonnegative(),
});

export const PlanPayloadSchema = z.object({
  title: z.string(),
  overview: z.string(),
  steps: z.array(PlanStepSchema).min(1),
  totalEstimate: z.number().int().nonnegative(),
  notes: z.string().nullable(),
});

export const WaitpointSchema = z.object({
  id: z.string(),
  runId: z.string(),
  type: WaitpointTypeSchema,
  status: WaitpointStatusSchema,
  payload: PlanPayloadSchema,
  resolution: PlanResolutionSchema.nullable(),
  supportedResolutions: z.array(PlanResolutionSchema),
  expiresAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const ResolveWaitpointRequestSchema = z.object({
  resolution: PlanResolutionSchema,
  /** Required when the resolution is REQUEST_CHANGES; ignored otherwise. */
  feedback: z.string().min(1).max(4_000).optional(),
  /** Makes a repeated submission safe to retry. */
  idempotencyKey: z.string().min(8).max(128),
});

export const ResolveWaitpointResponseSchema = z.object({
  waitpointId: z.string(),
  runId: z.string(),
  status: WaitpointStatusSchema,
  resolution: PlanResolutionSchema.nullable(),
  /**
   * False when this call did not change anything: the waitpoint was already
   * resolved or had expired. A duplicate submit is a 200, not an error — the
   * user pressed a button twice, which is not a failure.
   */
  applied: z.boolean(),
});

export type PlanResolution = z.infer<typeof PlanResolutionSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanPayload = z.infer<typeof PlanPayloadSchema>;
export type Waitpoint = z.infer<typeof WaitpointSchema>;
export type ResolveWaitpointRequest = z.infer<
  typeof ResolveWaitpointRequestSchema
>;
