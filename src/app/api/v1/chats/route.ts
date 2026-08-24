import { CreateChatRequestSchema } from "@/contracts/chat";
import { chatFixture, chatListFixture } from "@/contracts/fixtures";
import { errorResponse, jsonResponse } from "@/http/errors";

// STUB (PLAN.md BE-0.4) — shape is final, data is fixture.
// Real implementation lands in BE-0.7.

export function GET() {
  return jsonResponse(chatListFixture);
}

export async function POST(request: Request) {
  const parsed = CreateChatRequestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return errorResponse("BAD_REQUEST", { issues: parsed.error.issues });
  }

  return jsonResponse(
    { ...chatFixture, title: parsed.data.title ?? null },
    { status: 201 },
  );
}
