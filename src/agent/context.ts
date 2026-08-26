import type { AgentMessage } from "@/agent/provider";

/** Hard caps keep a long chat from overflowing the provider context window. */
export const MAX_CONTEXT_MESSAGES = 48;
export const MAX_CONTEXT_CHARACTERS = 60_000;

export type PersistedContextRow = {
  role: "USER" | "ASSISTANT";
  content: string;
};

/**
 * Selects newest persisted turns up to the character budget, then restores
 * chronological order. The first retained turn is always a user turn so the
 * provider never receives a context fragment beginning with an orphan answer.
 */
export function selectBoundedConversation(
  newestFirst: PersistedContextRow[],
): AgentMessage[] {
  const selected: PersistedContextRow[] = [];
  let characters = 0;

  for (const row of newestFirst.slice(0, MAX_CONTEXT_MESSAGES)) {
    if (row.content.length === 0) continue;

    if (
      selected.length > 0 &&
      characters + row.content.length > MAX_CONTEXT_CHARACTERS
    ) {
      break;
    }

    selected.push(row);
    characters += row.content.length;
  }

  selected.reverse();

  const firstUser = selected.findIndex((row) => row.role === "USER");
  const complete = firstUser < 0 ? [] : selected.slice(firstUser);

  return complete.map((row) => ({
    role: row.role === "USER" ? ("user" as const) : ("assistant" as const),
    content: row.content,
  }));
}
