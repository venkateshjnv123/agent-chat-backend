# Agent Chat Backend

Durable API and agent orchestration backend for Galaxy Agent Chat work trial.

## Status

Foundation scaffold only: Next.js route-handler service, strict TypeScript, Zod environment/health contracts, Prisma 7 wiring, Vitest, linting, formatting. Chat schema and provider integrations follow as bounded slices.

## Local setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Health endpoints:

- `GET /`
- `GET /api/v1/health`

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

## Architecture rules

- PostgreSQL owns durable state; Trigger.dev Realtime delivers updates.
- Backend-owned Zod contracts define every trust boundary.
- Prisma uses pooled `DATABASE_URL` at runtime and direct `DIRECT_URL` for migrations.
- Agent loop targets provider interface; only `openrouter/free` will be configured.
- Tool definitions drive model schema, validation, cost, execution, and renderer key.
- Idempotency constraints protect send, dispatch, tool completion, settlement, and approval.

See [AGENTS.md](./AGENTS.md) for implementation constraints.

## Planned repository shape

```text
src/app/api/v1/     Route Handlers
src/contracts/      authoritative Zod contracts
src/auth/           Clerk verification and ownership
src/db/             Prisma and cursor helpers
src/agent/          provider-neutral loop, tools, skills
src/providers/      Magica and Transloadit clients
src/credits/        reserve/settle/refund ledger
src/realtime/       Trigger.dev publishing
trigger/            parent and child tasks
prisma/             schema and committed migrations
agent-skills/       selectively loaded skills
tests/              focused contract/state tests
```

## Environment

Copy `.env.example`; never commit values. `OPENROUTER_MODEL` accepts only `openrouter/free`. Transloadit and asset-storage variables remain optional until P0.5 upload work.

## Migration notes

No application migration exists yet. First database slice will commit schema plus SQL migration, including partial unique active-run index. Each migration must document forward behavior and explicit rollback SQL or recovery procedure here.

## Declared cuts

MCP server, outbound webhooks, broad public API productization, extra tools/providers, search/pin, audio/video upload UI, and more than three Playwright smoke paths.
