import { LedgerListResponseSchema } from "@/contracts/credits";
import { prisma } from "@/db/client";
import { encodeCursor } from "@/db/cursor";
import { withAuth } from "@/http/context";
import { jsonResponse } from "@/http/errors";

const LIMIT = 50;

export async function GET(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const account = await prisma.creditAccount.findUnique({
      where: { ownerId: userAccountId },
    });

    if (!account) {
      return jsonResponse(
        LedgerListResponseSchema.parse({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
        { trace },
      );
    }

    const rows = await prisma.creditLedgerEntry.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "desc" },
      take: LIMIT + 1,
    });

    const hasMore = rows.length > LIMIT;
    const page = hasMore ? rows.slice(0, LIMIT) : rows;
    const last = page.at(-1);

    return jsonResponse(
      LedgerListResponseSchema.parse({
        items: page.map((entry) => ({
          id: entry.id,
          delta: entry.delta,
          kind: entry.kind,
          toolName: entry.toolName,
          runId: entry.runId,
          note: entry.note,
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor:
          hasMore && last ? encodeCursor([last.createdAt.toISOString()]) : null,
        hasMore,
      }),
      { trace },
    );
  });
}
