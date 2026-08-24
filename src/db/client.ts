import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { readDatabaseUrl } from "@/env/server";

// Prisma 7 takes the connection through a driver adapter rather than the schema.
// Runtime always uses the POOLED Neon URL — a serverless function per request
// would exhaust direct connections. Migrations use DIRECT_URL via prisma.config.ts.
function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: readDatabaseUrl() }),
  });
}

// Next.js hot-reloads modules in development; without this every reload leaks a
// pool. The global is intentionally not used in production.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
