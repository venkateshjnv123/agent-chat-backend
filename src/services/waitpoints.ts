import { wait } from "@trigger.dev/sdk";

import type { PlanPayload, PlanResolution } from "@/contracts/waitpoint";
import { PlanPayloadSchema } from "@/contracts/waitpoint";
import { prisma } from "@/db/client";

/**
 * Human waitpoints: the run stops, a person decides, the run continues.
 *
 * Two systems have to agree here. Trigger.dev owns the durable pause — a run
 * blocked on a token is checkpointed, costs nothing, and survives a deploy.
 * PostgreSQL owns the truth about what was asked and what was answered, because
 * the browser reads state from our API and must see the same thing after a
 * reload as it did before.
 *
 * The `Waitpoint` row is therefore written first and completed last: the token
 * is only ever resolved after the row says it was, so a client that sees an
 * answered plan can rely on the run having been released.
 */

/** A plan left unanswered has to end somewhere, or the run waits forever. */
const EXPIRY_MS = 60 * 60 * 1000;

/**
 * `STEP_BY_STEP` is not implemented, so it is not offered.
 *
 * The client renders the buttons this list names rather than a hard-coded set,
 * which is what stops an unsupported action being shown and then silently
 * downgraded to something else.
 */
export const SUPPORTED_RESOLUTIONS: PlanResolution[] = [
  "RUN_ALL",
  "REQUEST_CHANGES",
];

export type PlanDecision = {
  resolution: PlanResolution;
  feedback: string | null;
};

/**
 * Creates the pending plan and the token that will release the run.
 *
 * Called from inside the task, so the token id is available to `wait.forToken`
 * immediately after this returns.
 */
export async function createPlanWaitpoint(options: {
  runId: string;
  plan: PlanPayload;
}): Promise<{ waitpointId: string; tokenId: string; expiresAt: Date }> {
  const plan = PlanPayloadSchema.parse(options.plan);
  const expiresAt = new Date(Date.now() + EXPIRY_MS);

  const token = await wait.createToken({ timeout: expiresAt });

  const waitpoint = await prisma.waitpoint.create({
    data: {
      runId: options.runId,
      type: "PLAN_APPROVAL",
      status: "PENDING",
      token: token.id,
      payload: plan as never,
      expiresAt,
    },
    select: { id: true },
  });

  return { waitpointId: waitpoint.id, tokenId: token.id, expiresAt };
}

export type ResolveOutcome = {
  waitpointId: string;
  runId: string;
  status: "PENDING" | "RESOLVED" | "EXPIRED" | "CANCELLED";
  resolution: PlanResolution | null;
  /** False when the call changed nothing: already resolved, or expired. */
  applied: boolean;
};

export class WaitpointError extends Error {
  constructor(
    readonly code: "waitpoint_not_found" | "waitpoint_forbidden",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WaitpointError";
  }
}

/**
 * Applies a person's decision to a pending plan.
 *
 * Ownership is checked through the run's chat rather than trusted from the
 * request: the waitpoint id is effectively a capability, and a leaked one must
 * not let a stranger release someone else's run.
 *
 * A second submission is a success, not an error. The user pressed a button
 * twice; the honest answer is the state that already holds, with `applied`
 * false so the UI can tell the two apart. Expiry is terminal for the same
 * reason — the run has already moved on, and pretending otherwise would leave
 * a card that can never resolve.
 */
export async function resolvePlanWaitpoint(options: {
  waitpointId: string;
  userAccountId: string;
  resolution: PlanResolution;
  feedback?: string;
}): Promise<ResolveOutcome> {
  const waitpoint = await prisma.waitpoint.findUnique({
    where: { id: options.waitpointId },
    select: {
      id: true,
      runId: true,
      status: true,
      token: true,
      resolution: true,
      expiresAt: true,
      run: { select: { chat: { select: { userId: true } } } },
    },
  });

  if (!waitpoint) {
    throw new WaitpointError(
      "waitpoint_not_found",
      404,
      "That approval no longer exists.",
    );
  }

  if (waitpoint.run.chat.userId !== options.userAccountId) {
    // Same shape as not-found on purpose: a stranger probing ids learns
    // nothing about which ones are real.
    throw new WaitpointError(
      "waitpoint_forbidden",
      404,
      "That approval no longer exists.",
    );
  }

  if (waitpoint.status !== "PENDING") {
    return {
      waitpointId: waitpoint.id,
      runId: waitpoint.runId,
      status: waitpoint.status,
      resolution: waitpoint.resolution,
      applied: false,
    };
  }

  if (waitpoint.expiresAt.getTime() <= Date.now()) {
    await prisma.waitpoint.update({
      where: { id: waitpoint.id },
      data: { status: "EXPIRED" },
    });

    return {
      waitpointId: waitpoint.id,
      runId: waitpoint.runId,
      status: "EXPIRED",
      resolution: null,
      applied: false,
    };
  }

  if (!SUPPORTED_RESOLUTIONS.includes(options.resolution)) {
    throw new WaitpointError(
      "waitpoint_forbidden",
      400,
      "That option isn't available on this plan.",
    );
  }

  // The conditional update is the race guard: two simultaneous clicks both
  // reach here, and only the one that still sees PENDING gets a row back.
  const claimed = await prisma.waitpoint.updateMany({
    where: { id: waitpoint.id, status: "PENDING" },
    data: {
      status: "RESOLVED",
      resolution: options.resolution,
      resolvedAt: new Date(),
    },
  });

  if (claimed.count === 0) {
    const current = await prisma.waitpoint.findUniqueOrThrow({
      where: { id: waitpoint.id },
      select: { status: true, resolution: true },
    });

    return {
      waitpointId: waitpoint.id,
      runId: waitpoint.runId,
      status: current.status,
      resolution: current.resolution,
      applied: false,
    };
  }

  // Released only after the row committed, so the run can never resume on a
  // decision the API would not report back.
  await wait.completeToken<PlanDecision>(waitpoint.token, {
    resolution: options.resolution,
    feedback: options.feedback ?? null,
  });

  return {
    waitpointId: waitpoint.id,
    runId: waitpoint.runId,
    status: "RESOLVED",
    resolution: options.resolution,
    applied: true,
  };
}

/** Marks a plan expired once its deadline passes without an answer. */
export async function expirePlanWaitpoint(waitpointId: string): Promise<void> {
  await prisma.waitpoint.updateMany({
    where: { id: waitpointId, status: "PENDING" },
    data: { status: "EXPIRED" },
  });
}
