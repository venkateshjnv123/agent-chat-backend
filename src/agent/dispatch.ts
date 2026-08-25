import { auth, tasks } from "@trigger.dev/sdk";

import type { AgentTurnPayload } from "@/../trigger/agentTurn";
import { readRequiredEnv } from "@/env/server";

export type Dispatch = {
  triggerRunId: string;
  realtimeToken: string;
  expiresAt: Date;
};

/**
 * Hands the turn to the worker and mints a run-scoped realtime token.
 *
 * The token is the only Trigger credential the browser ever sees: it is scoped
 * to this run and short-lived, so it cannot be replayed against another user's
 * work. The static server key never leaves the backend.
 */
export async function dispatchAgentTurn(
  payload: AgentTurnPayload,
): Promise<Dispatch> {
  // Attempt 0 keys on the run id alone so the original send keeps the exact
  // idempotency it has always had; a retry has to look different to Trigger or
  // the platform swallows the dispatch and reports success for work that never
  // ran.
  const idempotencyKey =
    payload.attempt && payload.attempt > 0
      ? `${payload.runId}:attempt:${payload.attempt}`
      : payload.runId;

  // Asserted here rather than at startup so the rest of the API stays usable
  // while the Trigger project is still being provisioned.
  readRequiredEnv(["TRIGGER_SECRET_KEY"]);

  const handle = await tasks.trigger<
    typeof import("@/../trigger/agentTurn").agentTurn
  >(
    "agent-turn",
    payload,
    // Trigger's own idempotency, on top of our unique constraint: a redelivered
    // dispatch of the same attempt must not enqueue a second execution.
    { idempotencyKey },
  );

  const { realtimeToken, expiresAt } = await mintRealtimeToken(handle.id);

  return { triggerRunId: handle.id, realtimeToken, expiresAt };
}

const TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Mints a token scoped to one run.
 *
 * The client re-requests this on mount, on reconnect and on expiry rather than
 * holding a long-lived credential, so a leaked token grants read access to a
 * single run for an hour and nothing else.
 */
export async function mintRealtimeToken(triggerRunId: string) {
  readRequiredEnv(["TRIGGER_SECRET_KEY"]);

  const realtimeToken = await auth.createPublicToken({
    scopes: { read: { runs: [triggerRunId] } },
    expirationTime: "1h",
  });

  return { realtimeToken, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) };
}
