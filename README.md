# Galaxy Agent Chat Backend

Durable API and agent-orchestration service for Galaxy Agent Chat. It accepts authenticated chat requests, persists every state transition in PostgreSQL, runs agent turns through Trigger.dev, streams progress to the frontend, and executes registry-driven media tools.

## What it does

- Authenticates requests with Clerk and scopes every resource to its owner.
- Creates chats and messages atomically and dispatches durable agent runs.
- Streams assistant text, activity, tool calls, and approval waitpoints through Trigger.dev Realtime.
- Reconciles every run from PostgreSQL after reloads, reconnects, token expiry, or terminal events.
- Supports cancellation, failed-run retry, plan approval, and step-by-step plan execution.
- Signs direct image, video, and audio uploads through Transloadit, verifies completed assemblies before use, and preserves attachment order for media tools such as video merging.
- Reserves, settles, and refunds tool credits through an auditable ledger.
- Loads application-owned skills on demand and records their content version against each run.

This service is currently an authenticated application backend, not a public developer API.

## Stack

- Next.js Route Handlers and strict TypeScript
- PostgreSQL with Prisma
- Clerk authentication
- Trigger.dev tasks and Realtime
- OpenRouter using `openrouter/free`
- Magica media tools
- Transloadit uploads
- Zod contracts
- Vitest

## Architecture overview

```text
Browser
  -> Clerk-authenticated Route Handler
  -> Zod request validation
  -> PostgreSQL transaction (source of truth)
  -> Trigger.dev agent worker
       -> OpenRouter model
       -> registry-driven skills and tools
       -> Magica tool workers
  -> persisted messages, runs, waitpoints, and credit entries
  -> Trigger.dev Realtime delivery
  -> browser REST reconciliation
```

PostgreSQL owns durable state. Realtime is delivery only; losing a realtime event must never lose or duplicate application state.

### Request and run lifecycle

1. A Clerk-authenticated request enters a Next.js Route Handler and is validated against a backend-owned Zod contract.
2. The service writes the user message and queued run in one PostgreSQL transaction. An idempotency key and database constraints prevent duplicate acceptance.
3. Trigger.dev executes the agent turn outside the request lifecycle. The worker restores context from PostgreSQL rather than process memory.
4. OpenRouter streams model output. Tool calls are validated through the registry; billable plans pause at a persisted approval waitpoint before execution.
5. Tool workers reserve credits, call Magica, then settle or refund the reservation from the provider result.
6. Realtime events update the browser quickly. REST reconciliation restores authoritative messages and run state after reloads, reconnects, token expiry, and terminal events.

## Prerequisites

- Node.js 20 or newer
- pnpm
- PostgreSQL database with pooled and direct connection URLs
- Clerk application
- OpenRouter API key
- Trigger.dev project for agent execution
- Magica credentials when using media tools
- Transloadit credentials when using uploads

## Setup instructions

Install dependencies and create local configuration:

```bash
pnpm install
cp .env.example .env.local
pnpm db:generate
pnpm db:migrate
```

Start the API on `http://localhost:3001`:

```bash
pnpm dev
```

In another terminal, start the Trigger.dev worker:

```bash
pnpm trigger:dev
```

Local chat requires three processes:

1. This backend on port `3001`.
2. The frontend on port `3000`.
3. The Trigger.dev worker.

Without the worker, message submission can succeed while no assistant response arrives.

This machine may use a TLS-intercepting proxy. Repository scripts already run outbound Node.js commands with the system CA where needed. Use `pnpm trigger:login` and `pnpm trigger:dev` instead of invoking the Trigger.dev CLI directly.

## Environment variables

| Variable                  | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`            | Pooled PostgreSQL URL used by the running application.              |
| `DIRECT_URL`              | Direct PostgreSQL URL used by Prisma migrations.                    |
| `CLERK_SECRET_KEY`        | Server-side Clerk API key.                                          |
| `CLERK_JWT_ISSUER_DOMAIN` | Expected issuer for Clerk session tokens.                           |
| `OPENROUTER_API_KEY`      | OpenRouter credential used by agent workers.                        |
| `OPENROUTER_MODEL`        | Must be `openrouter/free`; paid fallback is intentionally rejected. |
| `MAGICA_API_KEY`          | Credential for Magica media operations.                             |
| `MAGICA_BASE_URL`         | Magica API base URL.                                                |
| `TRIGGER_PROJECT_REF`     | Trigger.dev project reference consumed by `trigger.config.ts`.      |
| `TRIGGER_SECRET_KEY`      | Trigger.dev server credential used to dispatch and inspect runs.    |
| `TRANSLOADIT_AUTH_KEY`    | Transloadit upload-signing key.                                     |
| `TRANSLOADIT_AUTH_SECRET` | Transloadit upload-signing secret.                                  |
| `FRONTEND_ORIGIN`         | Comma-separated CORS allowlist, such as `http://localhost:3000`.    |

Keep secrets in `.env.local` or the deployment provider. Never commit real credentials or expose them through `NEXT_PUBLIC_*` variables.

## API

All endpoints except service health require a Clerk bearer token. Authenticated resources return `404` for both missing and unowned IDs to avoid leaking resource existence.

### Public health

| Method | Path             | Purpose                           |
| ------ | ---------------- | --------------------------------- |
| `GET`  | `/`              | Service identity and API version. |
| `GET`  | `/api/v1/health` | Health status and timestamp.      |

### Chats and messages

| Method   | Path                             | Purpose                                                             |
| -------- | -------------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/api/v1/chats`                  | List, search, and cursor-page owned chats.                          |
| `POST`   | `/api/v1/chats`                  | Create an empty chat.                                               |
| `GET`    | `/api/v1/chats/:chatId`          | Read one owned chat.                                                |
| `PATCH`  | `/api/v1/chats/:chatId`          | Rename or pin a chat.                                               |
| `DELETE` | `/api/v1/chats/:chatId`          | Soft-delete a chat without an active run.                           |
| `GET`    | `/api/v1/chats/:chatId/messages` | Cursor-page persisted messages.                                     |
| `POST`   | `/api/v1/chats/:chatId/messages` | Send a message to an existing chat.                                 |
| `POST`   | `/api/v1/messages`               | Canonical send; creates a chat atomically when `chatId` is omitted. |

### Runs and approvals

| Method | Path                                      | Purpose                                                    |
| ------ | ----------------------------------------- | ---------------------------------------------------------- |
| `GET`  | `/api/v1/chats/:chatId/runs/:runId`       | Read authoritative run state and recover missing dispatch. |
| `POST` | `/api/v1/runs/:runId/realtime-token`      | Issue a short-lived, run-scoped realtime token.            |
| `POST` | `/api/v1/runs/:runId/cancel`              | Idempotently request cancellation.                         |
| `POST` | `/api/v1/runs/:runId/retry`               | Retry an eligible failed run.                              |
| `GET`  | `/api/v1/runs/:runId/waitpoint`           | Read the latest approval waitpoint.                        |
| `GET`  | `/api/v1/runs/:runId/waitpoints`          | Read complete approval history.                            |
| `POST` | `/api/v1/waitpoints/:waitpointId/resolve` | Run all steps, run step-by-step, or request changes.       |

### Attachments and credits

| Method | Path                                         | Purpose                                      |
| ------ | -------------------------------------------- | -------------------------------------------- |
| `GET`  | `/api/v1/attachments`                        | List owned uploads.                          |
| `POST` | `/api/v1/attachments`                        | Sign a constrained direct upload.            |
| `POST` | `/api/v1/attachments/:attachmentId/complete` | Verify and finalize a Transloadit assembly.  |
| `GET`  | `/api/v1/credits`                            | Read available and reserved credit balances. |
| `GET`  | `/api/v1/credits/ledger`                     | Cursor-page the auditable credit ledger.     |

Request and response shapes live in `src/contracts`. The frontend consumes synchronized generated copies; it must not redefine or hand-edit them.

## Tools and skills

Tool definitions live in `src/tools/definitions` and are registered in `src/tools/registry.ts`. Each definition owns its model schema, runtime validation, provider input mapping, result mapping, and frontend renderer key.

Generated tool schemas must stay synchronized:

```bash
pnpm tools:generate
pnpm tools:check
```

Application skills live under `agent-skills/<skill-name>/SKILL.md`. Skills are discovered and validated from disk, loaded only when requested by the agent, and recorded by content hash for deterministic resume behavior.

## Contracts

Backend Zod schemas under `src/contracts` are authoritative. Synchronize them into the sibling frontend repository with:

```bash
pnpm contracts:sync
pnpm contracts:check
```

`contracts:check` fails when generated frontend files drift from backend-owned contracts.

## Database and migrations

Prisma schema and committed migrations live under `prisma/`.

```bash
pnpm db:generate
pnpm db:validate
pnpm db:migrate
```

Runtime traffic uses `DATABASE_URL`; migrations use `DIRECT_URL`. Do not edit an applied migration. Add a new migration with forward behavior and a documented rollback or recovery procedure.

## Verification

Run the full local gate before handoff:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm contracts:check
pnpm tools:check
git diff --check
```

Database concurrency tests require a configured PostgreSQL test database:

```bash
RUN_DB_TESTS=1 pnpm test
```

Live Magica tests are opt-in because they call an external service:

```bash
MAGICA_LIVE=1 pnpm exec vitest run tests/magica.live.test.ts
```

## Production smoke test

`scripts/prod-smoke.mjs` exercises the deployed system as a real user: Clerk session creation, message submission, Trigger.dev execution, optional plan resolution, terminal-state reconciliation, and persisted history.

```bash
node --use-system-ca scripts/prod-smoke.mjs "Reply with exactly: smoke-ok"
```

Supported smoke variables include `BACKEND_URL`, `CLERK_SECRET_KEY`, `SMOKE_USER_EMAIL`, `SMOKE_USER_PASSWORD`, `SMOKE_FRONTEND_ORIGIN`, `SMOKE_EXISTING_SESSION_ID`, and `TOKEN_URL`.

The smoke test touches production services and may create chats, runs, and ledger activity. Use a dedicated test account.

## Repository layout

```text
src/app/api/v1/       authenticated HTTP route handlers
src/contracts/        authoritative Zod API and realtime contracts
src/auth/             Clerk verification and ownership checks
src/db/               Prisma client and cursor encoding
src/services/         durable application operations
src/agent/            provider-neutral agent loop and dispatch
src/tools/            registry-driven tool definitions and execution
src/skills/           skill discovery, validation, and loading
src/magica/           Magica API adapter
trigger/              Trigger.dev parent and child tasks
prisma/               schema and committed SQL migrations
agent-skills/         application-owned skill bundles
scripts/              contract generation and production smoke tooling
tests/                contract, service, recovery, and integration tests
```

## What I would improve with more time

1. More failure and error handling, reducing latency and try to scale this to more users.
2. Add end to end CI/CD pipelines from lint to deployment
3. Improve logs systems, currently i need to start with backend, Openrouter API, trigger.dev to find the errors - create a simple log system and add appropriate logs something like a distributed logs systems.
4. Media lifecycle management - integrate S3 or any object storage to make the files durable and maintainable easily
5. Integrate and handling the turns using webhooks
6. Currently skills are scalable but feeding them to openRouter is not scalable now i guess for 1000 skills - we need to check another way maybe make them lightweight.

See [AGENTS.md](./AGENTS.md) for repository constraints and required engineering invariants.
