import { verifyToken } from "@clerk/backend";

import { readRequiredEnv } from "@/env/server";

export type AuthedUser = {
  clerkUserId: string;
};

/**
 * Verifies the Clerk session token on the Authorization header.
 *
 * Clerk session tokens are short-lived (~60s) and the frontend refreshes them
 * per request, so an expired token is an ordinary event here, not an anomaly —
 * it returns null and the caller answers 401.
 */
export async function verifyRequest(
  request: Request,
): Promise<AuthedUser | null> {
  const header = request.headers.get("authorization");

  if (!header?.startsWith("Bearer ")) return null;

  const token = header.slice("Bearer ".length).trim();

  if (!token) return null;

  const { CLERK_SECRET_KEY, CLERK_JWT_ISSUER_DOMAIN } = readRequiredEnv([
    "CLERK_SECRET_KEY",
    "CLERK_JWT_ISSUER_DOMAIN",
  ]);

  try {
    const payload = await verifyToken(token, {
      secretKey: CLERK_SECRET_KEY,
      // Networkless verification against the instance that issued the token.
      jwtKey: undefined,
      audience: undefined,
    });

    if (
      typeof payload.iss === "string" &&
      !payload.iss.includes(CLERK_JWT_ISSUER_DOMAIN.replace(/^https?:\/\//, ""))
    ) {
      return null;
    }

    return payload.sub ? { clerkUserId: payload.sub } : null;
  } catch {
    // Never surface the verification error: it distinguishes "expired" from
    // "forged", which is information an unauthenticated caller should not have.
    return null;
  }
}
