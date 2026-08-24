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

    return jsonResponse(
      CreditBalanceSchema.parse({
        availableBalance: account.balance,
        formatted: formatCredits(account.balance),
      }),
      { trace },
    );
  });
}
