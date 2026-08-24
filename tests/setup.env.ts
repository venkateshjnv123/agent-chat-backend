import { readFileSync } from "node:fs";

// Integration tests talk to the real Neon database, which means they need the
// same local secrets the app uses. Unit tests ignore this entirely.
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);

    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // Absent in CI; integration tests skip themselves when DATABASE_URL is unset.
}
