import { readFileSync } from "node:fs";

import { defineConfig, env } from "prisma/config";

// Next.js reads .env.local; Prisma only reads .env. Load .env.local here so a
// single file holds local secrets and migrations see the direct connection.
loadEnvFile(".env.local");

function loadEnvFile(path: string): void {
  let contents: string;

  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);

    if (!match) continue;

    const [, key, rawValue] = match;

    if (process.env[key] !== undefined) continue;

    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
