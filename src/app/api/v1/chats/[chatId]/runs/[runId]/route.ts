import { runStateFixture } from "@/contracts/fixtures";
import { jsonResponse } from "@/http/errors";

// STUB (PLAN.md BE-0.4). This is the REST reconciliation endpoint the client
// falls back to whenever realtime drops, a token expires, or a run reaches a
// terminal state. Real implementation lands with BE-0.9.

export async function GET(
  _request: Request,
  context: { params: Promise<{ chatId: string; runId: string }> },
) {
  const { chatId, runId } = await context.params;

  return jsonResponse({ ...runStateFixture, id: runId, chatId });
}
