#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Copies backend-owned Zod contracts into the frontend.
 *
 * Two repos mean the contract has to physically move. Copying source rather
 * than generating types keeps runtime validation on both sides: the frontend
 * parses responses with the same schema the backend produced them from, so a
 * shape drift fails loudly at the boundary instead of silently downstream.
 *
 *   pnpm contracts:sync         write the generated files
 *   pnpm contracts:check        fail if they are stale (CI drift check)
 */

const SOURCE_DIR = resolve(import.meta.dirname, "../src/contracts");
const TARGET_DIR = resolve(
  import.meta.dirname,
  "../../agent-chat-frontend/src/contracts/generated",
);

// Server-only modules must never reach the browser bundle.
const EXCLUDE = new Set(["fixtures.ts"]);

const BANNER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: agent-chat-backend/src/contracts/
 * Regenerate with \`pnpm contracts:sync\` in the backend repo.
 * CI runs \`pnpm contracts:check\`, which fails if this file is stale.
 */

`;

const check = process.argv.includes("--check");

const files = readdirSync(SOURCE_DIR)
  .filter((name) => name.endsWith(".ts") && !EXCLUDE.has(name))
  .sort();

const written = [];
let stale = false;

mkdirSync(TARGET_DIR, { recursive: true });

for (const name of files) {
  const source = readFileSync(join(SOURCE_DIR, name), "utf8");
  const contents = BANNER + source;
  const target = join(TARGET_DIR, name);

  let existing = null;

  try {
    existing = readFileSync(target, "utf8");
  } catch {
    existing = null;
  }

  if (existing !== contents) {
    stale = true;

    if (!check) writeFileSync(target, contents, "utf8");
  }

  written.push({
    name,
    sha256: createHash("sha256").update(source).digest("hex").slice(0, 16),
  });
}

// A manifest makes drift a one-line diff rather than a file-by-file comparison.
const manifest =
  BANNER +
  `export const CONTRACT_MANIFEST = ${JSON.stringify(
    Object.fromEntries(written.map((f) => [f.name, f.sha256])),
    null,
    2,
  )} as const;\n`;

const manifestPath = join(TARGET_DIR, "manifest.ts");

let existingManifest = null;

try {
  existingManifest = readFileSync(manifestPath, "utf8");
} catch {
  existingManifest = null;
}

if (existingManifest !== manifest) {
  stale = true;

  if (!check) writeFileSync(manifestPath, manifest, "utf8");
}

if (check && stale) {
  console.error(
    "Generated frontend contracts are stale. Run `pnpm contracts:sync` in agent-chat-backend and commit the result.",
  );
  process.exit(1);
}

console.log(
  check
    ? "Generated contracts are up to date."
    : `Synced ${written.length + 1} files to agent-chat-frontend/src/contracts/generated/`,
);
