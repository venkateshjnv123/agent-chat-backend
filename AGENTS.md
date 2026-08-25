# Repository Rules

## Stack and commands

- Next.js Route Handlers, strict TypeScript, pnpm, Prisma/PostgreSQL, Clerk, Zod, Trigger.dev, Vitest.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before handoff.
- Run `pnpm format:check` and `git diff --check` before commit.
- This machine sits behind a TLS-intercepting proxy: plain Node fails with `SELF_SIGNED_CERT_IN_CHAIN`. Every command that opens an outbound TLS connection runs under `--use-system-ca`. Use `pnpm trigger:login` / `pnpm trigger:dev`, never a bare `trigger.dev` invocation — the CLI reports the cert failure as `Connection error` / `You must login first`, which sends you hunting a non-existent auth bug.
- Local chat needs three processes: `pnpm dev` (backend :3001), the frontend on :3000, and `pnpm trigger:dev`. Without the worker, sends are accepted and no answer ever arrives.

## Non-negotiables

- PostgreSQL is sole source of truth. Realtime is delivery only.
- Validate every trust boundary with backend-owned Zod contracts.
- Use `openrouter/free` only. Never configure paid fallback.
- Keep secrets out of logs, persisted content, client code, and commits.
- Every state-changing endpoint needs idempotency or uniqueness test.
- Restore agent context from PostgreSQL; never depend on process memory.
- JSONB only stores validated content blocks or provider-neutral tool payloads.
- Keep provider, orchestration, persistence, and tool adapters separate.
- Adding tool must not add branch to agent loop.
- One bounded vertical slice per task. Avoid multi-concern changes.

## Contracts

- `src/contracts` owns API shapes.
- Frontend consumes generated/synchronized output; never edit generated frontend contracts.
- Contract sync must be deterministic and CI must detect drift.
