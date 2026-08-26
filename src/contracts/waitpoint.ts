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

/** Server-supported actions. Client renders only `supportedResolutions`. */
export const PlanResolutionSchema = z.enum([
  "RUN_ALL",
  "STEP_BY_STEP",
  "REQUEST_CHANGES",
]);

export const PlanStepSchema = z.object({
  /** Stable within this plan and across persisted/reloaded card rendering. */
  id: z.string().min(1),
  n: z.number().int().positive(),
  toolName: z.string().min(1),
  title: z.string(),
  description: z.string(),
  dependsOn: z.array(z.string()).default([]),
  /** Sanitized provider-neutral input. May contain `$fromStep` references. */
  input: z.record(z.string(), z.unknown()).default({}),
  /** Microcredits, from the batched estimate call. Renders as `~X.XXXXM`. */
  estimateCredits: z.number().int().nonnegative(),
  status: z
    .enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "SKIPPED"])
    .default("PENDING"),
});

const CurrentPlanPayloadSchema = z.object({
  title: z.string(),
  overview: z.string(),
  steps: z.array(PlanStepSchema).min(1),
  totalEstimate: z.number().int().nonnegative(),
  notes: z.string().nullable(),
});

/** Upgrades pre-graph persisted cards without mutating their audit rows. */
export const PlanPayloadSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.steps)) return value;

  return {
    ...payload,
    steps: payload.steps.map((rawStep, index) => {
      if (!rawStep || typeof rawStep !== "object") return rawStep;
      const step = rawStep as Record<string, unknown>;
      const fallbackName =
        typeof step.title === "string"
          ? step.title.toLowerCase().replace(/[^a-z0-9]+/g, "_")
          : "legacy_step";

      return {
        id: `step_${index + 1}`,
        toolName: fallbackName,
        dependsOn: [],
        input: {},
        status: "PENDING",
        ...step,
      };
    }),
  };
}, CurrentPlanPayloadSchema);

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

export const WaitpointHistorySchema = z.object({
  items: z.array(WaitpointSchema),
});

export const ResolveWaitpointRequestSchema = z
  .object({
    resolution: PlanResolutionSchema,
    /** Required when the resolution is REQUEST_CHANGES; ignored otherwise. */
    feedback: z.string().trim().min(1).max(4_000).optional(),
    /** Makes a repeated submission safe to retry. */
    idempotencyKey: z.string().min(8).max(128),
  })
  .superRefine((value, context) => {
    if (value.resolution === "REQUEST_CHANGES" && !value.feedback) {
      context.addIssue({
        code: "custom",
        path: ["feedback"],
        message: "Say what you want changed.",
      });
    }
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
export type WaitpointHistory = z.infer<typeof WaitpointHistorySchema>;
export type ResolveWaitpointRequest = z.infer<
  typeof ResolveWaitpointRequestSchema
>;
