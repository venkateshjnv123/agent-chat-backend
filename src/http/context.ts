import { resolveUserAccount } from "@/auth/ownership";
import { verifyRequest } from "@/auth/verifyClerkToken";
import { errorResponse, traceId } from "@/http/errors";

export type RequestContext = {
  userAccountId: string;
  clerkUserId: string;
  trace: string;
};

type Handler<T> = (context: RequestContext) => Promise<T>;

/**
 * Wraps a route handler with authentication and the uniform error envelope.
 *
 * Every route gets the same trace id in its response headers, its error body,
 * and its structured logs, so a failure visible in the UI can be traced to a
 * single request without asking the user for anything but the id.
 */
export async function withAuth(
  request: Request,
  handler: Handler<Response>,
): Promise<Response> {
  const trace = traceId();

  let user;

  try {
    user = await verifyRequest(request);
  } catch (error) {
    // A misconfigured server is not the caller's fault and must not read as an
    // auth failure: 500 with a trace id, never a misleading 401.
    console.error(
      JSON.stringify({
        level: "error",
        traceId: trace,
        message: error instanceof Error ? error.message : "auth misconfigured",
      }),
    );

    return errorResponse("INTERNAL", { trace });
  }

  if (!user) {
    return errorResponse("UNAUTHORIZED", { trace });
  }

  try {
    const account = await resolveUserAccount(user.clerkUserId);

    return await handler({
      userAccountId: account.id,
      clerkUserId: user.clerkUserId,
      trace,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        traceId: trace,
        clerkUserId: user.clerkUserId,
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );

    return errorResponse("INTERNAL", { trace });
  }
}
