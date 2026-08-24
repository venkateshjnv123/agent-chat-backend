import { findOwnedChat } from "@/auth/ownership";
import {
  ListMessagesQuerySchema,
  MessageListResponseSchema,
  SendMessageRequestSchema,
} from "@/contracts/chat";
import { prisma } from "@/db/client";
import { decodeSequenceCursor, encodeCursor } from "@/db/cursor";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { handleSend } from "@/services/send";
import { serializeMessage } from "@/services/serialize";

export async function GET(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { chatId } = await context.params;

    if (!(await findOwnedChat(userAccountId, chatId))) {
      return errorResponse("NOT_FOUND", { trace });
    }

    const url = new URL(request.url);
    const parsed = ListMessagesQuerySchema.safeParse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    if (!parsed.success) {
      return errorResponse("BAD_REQUEST", {
        issues: parsed.error.issues,
        trace,
      });
    }

    const cursor = parsed.data.cursor
      ? decodeSequenceCursor(parsed.data.cursor)
      : null;

    if (parsed.data.cursor && cursor === null) {
      return errorResponse("BAD_REQUEST", { trace });
    }

    // Newest first, paging on the epoch-millis sequence. Never skip/take: an
    // offset re-reads rows the client already saw when a turn lands mid-scroll.
    const rows = await prisma.message.findMany({
      where: {
        chatId,
        ...(cursor !== null ? { sequence: { lt: cursor } } : {}),
      },
      orderBy: { sequence: "desc" },
      take: parsed.data.limit + 1,
      include: { toolInvocations: { orderBy: { createdAt: "asc" } } },
    });

    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const last = page.at(-1);

    return jsonResponse(
      MessageListResponseSchema.parse({
        items: page.map(serializeMessage),
        nextCursor:
          hasMore && last ? encodeCursor([last.sequence.toString()]) : null,
        hasMore,
      }),
      { trace },
    );
  });
}

/**
 * Nested send, kept for symmetry with the read route. Delegates to the same
 * implementation as `POST /v1/messages`; the path supplies the chat id.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  return withAuth(request, async (auth) => {
    const { chatId } = await context.params;
    const parsed = SendMessageRequestSchema.safeParse(await request.json());

    if (!parsed.success) {
      return errorResponse("BAD_REQUEST", {
        issues: parsed.error.issues,
        trace: auth.trace,
      });
    }

    return handleSend(auth, { ...parsed.data, chatId });
  });
}
