import { CreditBalanceSchema } from "@/contracts/credits";
import { prisma } from "@/db/client";
import { withAuth } from "@/http/context";
import { jsonResponse } from "@/http/errors";
import { formatCredits } from "@/services/credits";
import { outstandingReservations } from "@/services/creditLedger";

export async function GET(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const account = await prisma.creditAccount.upsert({
      where: { ownerId: userAccountId },
      update: {},
      create: { ownerId: userAccountId },
    });

    // Reservations are derived from the ledger, not stored: a reservation is
    // outstanding exactly while it has no settlement or refund. `balance` is
    // already net of them, so this figure is for display only.
    const reservedBalance = await outstandingReservations(account.id);

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
