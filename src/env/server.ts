import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

export const ServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_JWT_ISSUER_DOMAIN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.literal("openrouter/free"),
  MAGICA_API_KEY: z.string().min(1),
  MAGICA_BASE_URL: z.url(),
  TRIGGER_SECRET_KEY: z.string().min(1),
  FRONTEND_ORIGIN: z.url(),
  TRANSLOADIT_AUTH_KEY: optionalString,
  TRANSLOADIT_AUTH_SECRET: optionalString,
  ASSET_STORAGE_URL: optionalUrl,
  ASSET_STORAGE_TOKEN: optionalString,
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
