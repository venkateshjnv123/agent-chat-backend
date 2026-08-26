import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional(),
);

/**
 * Narrow read for the database connection.
 *
 * The Prisma client is imported by every route, so validating the whole
 * environment there would make a chat list fail because a tool provider key is
 * absent. Infrastructure fails fast; provider keys are asserted where they are
 * used, which also keeps the stubbed surface runnable during setup.
 */
export function readRequiredEnv<const K extends readonly string[]>(
  keys: K,
): Record<K[number], string> {
  const missing = keys.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    // Field names only. A value must never reach a log line or a response.
    throw new Error(`Invalid server environment: ${missing.sort().join(", ")}`);
  }

  return Object.fromEntries(
    keys.map((key) => [key, process.env[key] as string]),
  ) as Record<K[number], string>;
}

export function readDatabaseUrl(): string {
  return readRequiredEnv(["DATABASE_URL"]).DATABASE_URL;
}

/**
 * CORS needs only the allowlist. Validating unrelated keys here would turn a
 * missing provider secret into a failed preflight, which reads as a CORS bug
 * and costs an hour to trace.
 */
export function readFrontendOrigins(): string[] {
  return (process.env.FRONTEND_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const ServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_JWT_ISSUER_DOMAIN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.literal("openrouter/free"),
  MAGICA_API_KEY: z.string().min(1),
  MAGICA_BASE_URL: z.url(),
  // Optional until the dispatch slice (PLAN.md BE-0.9). Asserted at the point of
  // use so stubbed routes stay runnable before the Trigger.dev project exists.
  TRIGGER_SECRET_KEY: optionalString,
  FRONTEND_ORIGIN: z.url(),
  TRANSLOADIT_AUTH_KEY: optionalString,
  TRANSLOADIT_AUTH_SECRET: optionalString,
});

const OpenRouterEnvSchema = ServerEnvSchema.pick({
  OPENROUTER_API_KEY: true,
  OPENROUTER_MODEL: true,
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function readServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  const result = ServerEnvSchema.safeParse(source);

  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ].sort();

    throw new Error(`Invalid server environment: ${fields.join(", ")}`);
  }

  return result.data;
}

/**
 * Reads only the OpenRouter settings when a model call is made.
 *
 * The literal model is checked here as well as in the full startup schema. A
 * serverless route does not necessarily call `readServerEnv` before the worker
 * opens a provider stream, so relying on startup validation alone could let a
 * changed environment silently select a paid model.
 */
export function readOpenRouterEnv(
  source: Record<string, string | undefined> = process.env,
): Pick<ServerEnv, "OPENROUTER_API_KEY" | "OPENROUTER_MODEL"> {
  const result = OpenRouterEnvSchema.safeParse(source);

  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ].sort();

    throw new Error(`Invalid server environment: ${fields.join(", ")}`);
  }

  return result.data;
}
