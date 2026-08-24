import { findOwnedChat } from "@/auth/ownership";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { serializeChat } from "@/services/serialize";

export async function GET(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { chatId } = await context.params;
    const chat = await findOwnedChat(userAccountId, chatId);

    // A chat owned by someone else is indistinguishable from one that does not
    // exist. 403 would confirm the id is real.
    if (!chat) return errorResponse("NOT_FOUND", { trace });

    return jsonResponse(serializeChat(chat), { trace });
  });
}
