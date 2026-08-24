import {
  ListMessagesQuerySchema,
  SendMessageRequestSchema,
} from "@/contracts/chat";
import { messageListFixture, sendMessageFixture } from "@/contracts/fixtures";
import { errorResponse, jsonResponse } from "@/http/errors";

// STUB (PLAN.md BE-0.4). Real implementations: read in BE-0.7, send in BE-0.8.

export async function GET(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await context.params;
  const url = new URL(request.url);

  const parsed = ListMessagesQuerySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });

  if (!parsed.success) {
    return errorResponse("BAD_REQUEST", { issues: parsed.error.issues });
  }

  return jsonResponse({
    ...messageListFixture,
    items: messageListFixture.items.map((message) => ({ ...message, chatId })),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await context.params;
  const parsed = SendMessageRequestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return errorResponse("BAD_REQUEST", { issues: parsed.error.issues });
  }

  // 202: the work is accepted, not complete. No model call happens in the
  // request path — that is what keeps this under 200ms and makes a reload
  // mid-run recoverable.
  return jsonResponse({ ...sendMessageFixture, chatId }, { status: 202 });
}
