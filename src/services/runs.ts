import { prisma } from "@/db/client";

/**
 * Loads a run only if the caller owns the chat it belongs to.
 *
 * Run ids are guessable enough that this has to be checked on every run route,
 * not just on the chat routes.
 */
export async function findOwnedRun(userAccountId: string, runId: string) {
  return prisma.agentRun.findFirst({
    where: { id: runId, chat: { userId: userAccountId } },
  });
}

export const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
