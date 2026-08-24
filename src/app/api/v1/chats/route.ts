import {
  ChatListResponseSchema,
  CreateChatRequestSchema,
} from "@/contracts/chat";
import { prisma } from "@/db/client";
import { decodeChatCursor, encodeCursor } from "@/db/cursor";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { serializeChat } from "@/services/serialize";

const DEFAULT_LIMIT = 30;

export async function GET(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const url = new URL(request.url);
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor ? decodeChatCursor(rawCursor) : null;

    if (rawCursor && !cursor) {
      return errorResponse("BAD_REQUEST", { trace });
    }

    // Fetch one extra row to learn whether another page exists without a count.
    const rows = await prisma.chat.findMany({
      where: {
        userId: userAccountId,
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: DEFAULT_LIMIT + 1,
    });

    const hasMore = rows.length > DEFAULT_LIMIT;
    const page = hasMore ? rows.slice(0, DEFAULT_LIMIT) : rows;
    const last = page.at(-1);

    return jsonResponse(
      ChatListResponseSchema.parse({
        items: page.map(serializeChat),
        nextCursor:
          hasMore && last
            ? encodeCursor([last.updatedAt.toISOString(), last.id])
            : null,
        hasMore,
      }),
      { trace },
    );
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const parsed = CreateChatRequestSchema.safeParse(await request.json());

    if (!parsed.success) {
      return errorResponse("BAD_REQUEST", {
        issues: parsed.error.issues,
        trace,
      });
    }

    const chat = await prisma.chat.create({
      data: { userId: userAccountId, title: parsed.data.title ?? null },
    });

    return jsonResponse(serializeChat(chat), { status: 201, trace });
  });
}
