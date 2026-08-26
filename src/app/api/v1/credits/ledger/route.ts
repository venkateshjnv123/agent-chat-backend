import {
  LedgerListResponseSchema,
  LedgerQuerySchema,
} from "@/contracts/credits";
import { prisma } from "@/db/client";
import { decodeCursor, encodeCursor } from "@/db/cursor";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";

/**
 * The credit ledger, newest first.
 *
 * Paged on `(createdAt, id)` rather than `createdAt` alone: entries for one
 * operation are written inside a single transaction and share a timestamp to
 * the microsecond, so a cursor on the timestamp alone would drop or repeat rows
 * exactly at a page boundary — which is where a reserve/settle/refund triple
 * would land.
 */
function decodeLedgerCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  const parts = decodeCursor(cursor);

  if (!parts || parts.length !== 2) return null;

  const createdAt = new Date(parts[0]);

  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: parts[1] };
}

export async function GET(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const url = new URL(request.url);
    const query = LedgerQuerySchema.safeParse(
      Object.fromEntries(url.searchParams),
    );

    if (!query.success) {
      return errorResponse("BAD_REQUEST", {
        issues: query.error.issues,
        trace,
      });
    }

    const { limit } = query.data;
    const account = await prisma.creditAccount.findUnique({
      where: { ownerId: userAccountId },
      select: { id: true },
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

    let after: { createdAt: Date; id: string } | null = null;

    if (query.data.cursor) {
      after = decodeLedgerCursor(query.data.cursor);

      // A cursor we cannot read is a client bug, not an empty page. Silently
      // restarting from the top would loop the list forever.
      if (!after) {
        return errorResponse("BAD_REQUEST", {
          message: "That page cursor isn't valid.",
          trace,
        });
      }
    }

    const rows = await prisma.creditLedgerEntry.findMany({
      where: {
        accountId: account.id,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return jsonResponse(
      LedgerListResponseSchema.parse({
        items: page.map((entry) => ({
          id: entry.id,
          delta: entry.delta,
          kind: entry.kind,
          toolName: entry.toolName,
          runId: entry.runId,
          toolInvocationId: entry.toolInvocationId,
          // Model usage is recorded at zero application credits so the turn
          // stays auditable; only Magica tools actually bill. A tool's own
          // settle row can also be zero when the estimate was exact, so the
          // flag keys off the absence of a tool, not off the delta.
          zeroRated: entry.toolName === null && entry.delta === 0,
          note: entry.note,
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor:
          hasMore && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
        hasMore,
      }),
      { trace },
    );
  });
}
