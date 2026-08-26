import {
  ChatListResponseSchema,
  CreateChatRequestSchema,
  ListChatsQuerySchema,
} from "@/contracts/chat";
import { prisma } from "@/db/client";
import { decodeChatCursor, encodeCursor } from "@/db/cursor";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { readJsonBody } from "@/http/body";
import { serializeChat } from "@/services/serialize";

const DEFAULT_LIMIT = 30;

export async function GET(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const url = new URL(request.url);
    const query = ListChatsQuerySchema.safeParse(
      Object.fromEntries(url.searchParams),
    );

    if (!query.success) {
      return errorResponse("BAD_REQUEST", {
        issues: query.error.issues,
        trace,
      });
    }

    const rawCursor = query.data.cursor;
    const cursor = rawCursor ? decodeChatCursor(rawCursor) : null;

    if (rawCursor && !cursor) {
      return errorResponse("BAD_REQUEST", { trace });
    }

    // Fetch one extra row to learn whether another page exists without a count.
    const rows = await prisma.chat.findMany({
      where: {
        userId: userAccountId,
        deletedAt: null,
        ...(query.data.q
          ? {
              OR: [
                {
                  title: { contains: query.data.q, mode: "insensitive" },
                },
                {
                  messages: {
                    some: {
                      content: {
                        contains: query.data.q,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              ],
            }
          : {}),
        ...(cursor
          ? {
              AND: [
                {
                  OR: [
                    ...(cursor.pinned ? [{ pinned: false }] : []),
                    {
                      pinned: cursor.pinned,
                      updatedAt: { lt: cursor.updatedAt },
                    },
                    {
                      pinned: cursor.pinned,
                      updatedAt: cursor.updatedAt,
                      id: { lt: cursor.id },
                    },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
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
            ? encodeCursor([
                last.pinned ? 1 : 0,
                last.updatedAt.toISOString(),
                last.id,
              ])
            : null,
        hasMore,
      }),
      { trace },
    );
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const parsed = CreateChatRequestSchema.safeParse(
      await readJsonBody(request),
    );

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
