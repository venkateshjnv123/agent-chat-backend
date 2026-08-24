import { HealthResponseSchema } from "@/contracts/service";

export function GET() {
  return Response.json(
    HealthResponseSchema.parse({
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
  );
}
