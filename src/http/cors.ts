import { readFrontendOrigins } from "@/env/server";

/**
 * The frontend is a separate origin, so every response needs CORS headers and
 * preflight has to succeed before any authed request will. Settling this early
 * is deliberate: discovering it at midnight costs an hour.
 */
export function allowedOrigins(): string[] {
  return readFrontendOrigins();
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !allowedOrigins().includes(origin)) return {};

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,idempotency-key,x-session-id,x-trace-id",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}
