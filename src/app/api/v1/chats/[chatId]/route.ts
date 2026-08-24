import { chatFixture } from "@/contracts/fixtures";
import { jsonResponse } from "@/http/errors";

// STUB (PLAN.md BE-0.4). Real ownership guard lands in BE-0.5:
// a chat owned by another user returns 404, never 403, so the API does not
// leak which ids exist.

export async function GET(
  _request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await context.params;

  return jsonResponse({ ...chatFixture, id: chatId });
}
