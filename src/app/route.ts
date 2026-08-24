import { ServiceResponseSchema } from "@/contracts/service";

export function GET() {
  return Response.json(
    ServiceResponseSchema.parse({
      service: "agent-chat-backend",
      status: "ok",
      version: "v1",
    }),
  );
}
