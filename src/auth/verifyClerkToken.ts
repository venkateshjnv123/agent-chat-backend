import { verifyToken } from "@clerk/backend";

import { readFrontendOrigins, readRequiredEnv } from "@/env/server";

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
    const authorizedParties = readFrontendOrigins();
    const payload = await verifyToken(token, {
      secretKey: CLERK_SECRET_KEY,
      // Clerk fetches and caches the instance JWKS from the secret-key-bound
      // Backend API. This supports signing-key rotation; it is not networkless.
      authorizedParties,
    });

    if (
      normalizeIssuer(payload.iss) !== normalizeIssuer(CLERK_JWT_ISSUER_DOMAIN)
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

/** Exact normalized origin/path comparison; prefixes and suffixes are invalid. */
function normalizeIssuer(value: unknown): string | null {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "");

    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return null;
  }
}
