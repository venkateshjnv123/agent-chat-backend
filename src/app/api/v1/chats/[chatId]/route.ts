import { findOwnedChat } from "@/auth/ownership";
import {
  DeleteChatResponseSchema,
  UpdateChatRequestSchema,
} from "@/contracts/chat";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import {
  ChatMutationError,
  softDeleteOwnedChat,
  updateOwnedChat,
} from "@/services/chats";
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { chatId } = await context.params;
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return errorResponse("BAD_REQUEST", { trace });
    }

    const parsed = UpdateChatRequestSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse("BAD_REQUEST", {
        issues: parsed.error.issues,
        trace,
      });
    }

    try {
      const chat = await updateOwnedChat(userAccountId, chatId, parsed.data);

      return jsonResponse(serializeChat(chat), { trace });
    } catch (error) {
      if (error instanceof ChatMutationError) {
        return errorResponse("NOT_FOUND", { trace });
      }

      throw error;
    }
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { chatId } = await context.params;

    try {
      const result = await softDeleteOwnedChat(userAccountId, chatId);

      return jsonResponse(DeleteChatResponseSchema.parse(result), { trace });
    } catch (error) {
      if (error instanceof ChatMutationError) {
        return errorResponse(error.status === 409 ? "CONFLICT" : "NOT_FOUND", {
          message:
            error.status === 409
              ? "Stop the active run before deleting this chat."
              : undefined,
          trace,
        });
      }

      throw error;
    }
  });
}
