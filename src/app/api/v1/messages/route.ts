import { SendMessageRequestSchema } from "@/contracts/chat";
import { readJsonBody } from "@/http/body";
import { withAuth } from "@/http/context";
import { errorResponse } from "@/http/errors";
import { handleSend } from "@/services/send";

/**
 * The canonical send.
 *
 * `chatId` is optional: omitting it creates the chat in the same transaction
 * that opens the run, so a first message is one round trip and a failed send
 * leaves no empty chat behind. The client routes to the returned chatId.
 */
export async function POST(request: Request) {
  return withAuth(request, async (context) => {
    const parsed = SendMessageRequestSchema.safeParse(
      await readJsonBody(request),
    );

    if (!parsed.success) {
      return errorResponse("BAD_REQUEST", {
        issues: parsed.error.issues,
        trace: context.trace,
      });
    }

    return handleSend(context, parsed.data);
  });
}
