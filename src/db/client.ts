import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { readDatabaseUrl } from "@/env/server";

/**
 * Prisma 7 takes the connection through a driver adapter rather than the
 * schema. Runtime always uses the POOLED Neon URL — a serverless function per
 * request would exhaust direct connections. Migrations use DIRECT_URL via
 * prisma.config.ts.
 *
 * The client is created on first query, not at import. Building the app reads
 * every module, and a build machine has no database URL; eager construction
 * turns `next build` into a task that needs production secrets.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: readDatabaseUrl() }),
  });
}

function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }

  return globalForPrisma.prisma;
}

/**
 * Proxies to a lazily constructed client so `import { prisma }` stays ergonomic
 * while construction is deferred to the first actual query.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(getPrismaClient(), property, receiver);
  },
});
