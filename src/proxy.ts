import { NextResponse, type NextRequest } from "next/server";

import { corsHeaders } from "@/http/cors";

/**
 * Next 16 renamed the middleware convention to `proxy`. Same interception
 * point: preflight is answered here so a cross-origin request never reaches a
 * route handler without CORS headers.
 */
export default function proxy(request: NextRequest) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers });
  }

  const response = NextResponse.next();

  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}

export const config = {
  matcher: "/api/:path*",
};
