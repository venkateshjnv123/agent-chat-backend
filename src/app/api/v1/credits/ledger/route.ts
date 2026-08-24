import { ledgerListFixture } from "@/contracts/fixtures";
import { jsonResponse } from "@/http/errors";

// STUB (PLAN.md BE-0.4). Real implementation lands in BE-2.6.

export function GET() {
  return jsonResponse(ledgerListFixture);
}
