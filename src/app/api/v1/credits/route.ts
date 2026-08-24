import { CreditBalanceSchema } from "@/contracts/credits";
import { prisma } from "@/db/client";
import { withAuth } from "@/http/context";
import { jsonResponse } from "@/http/errors";
import { formatCredits } from "@/services/credits";

export async function GET(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const account = await prisma.creditAccount.upsert({
      where: { ownerId: userAccountId },
      update: {},
      create: { ownerId: userAccountId },
    });

    // Reserved credit is held by runs that started but have not settled.
    const reserved = await prisma.creditLedgerEntry.aggregate({
      where: { accountId: account.id, kind: "RESERVE" },
      _sum: { delta: true },
    });
    const settled = await prisma.creditLedgerEntry.aggregate({
      where: { accountId: account.id, kind: { in: ["SETTLE", "REFUND"] } },
      _sum: { delta: true },
    });

    const reservedBalance = Math.max(
      0,
      -((reserved._sum.delta ?? 0) + (settled._sum.delta ?? 0)),
    );

    return jsonResponse(
      CreditBalanceSchema.parse({
        availableBalance: account.balance,
        reservedBalance,
        formatted: formatCredits(account.balance),
      }),
      { trace },
    );
  });
}
