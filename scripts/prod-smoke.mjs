/**
 * End-to-end smoke test against the deployed backend.
 *
 * Runs the whole turn as a real user would: mint a Clerk session for a test
 * account, send a message, watch the run to a terminal state, answer a plan
 * card if one appears, and read the persisted history back. Everything it
 * touches is production — the deployed routes, the deployed Trigger worker,
 * OpenRouter and Magica.
 *
 *   node --use-system-ca scripts/prod-smoke.mjs "<prompt>"
 *
 * Env: BACKEND_URL, CLERK_SECRET_KEY, SMOKE_USER_EMAIL, SMOKE_USER_PASSWORD.
 */

import { readFileSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  } catch {
    // A missing env file is normal in CI; required values are checked below.
  }
}

const BACKEND =
  process.env.BACKEND_URL ?? "https://agent-chat-backend.vercel.app";
const CLERK = "https://api.clerk.com/v1";
const SECRET = process.env.CLERK_SECRET_KEY;
const EMAIL = process.env.SMOKE_USER_EMAIL ?? "smoke+agentchat@example.com";
const PASSWORD = process.env.SMOKE_USER_PASSWORD ?? "Sm0ke-Test-Passw0rd!42";
const SMOKE_SESSION_ID = `prod-smoke-${Date.now()}`;

if (!SECRET) throw new Error("CLERK_SECRET_KEY is required");

const step = (message, extra) =>
  console.log(`\n▸ ${message}`, extra === undefined ? "" : extra);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function clerk(path, init = {}) {
  const response = await fetch(`${CLERK}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Clerk ${path} → ${response.status} ${body.slice(0, 400)}`);
  }

  return body ? JSON.parse(body) : null;
}

/** Reuses the test account when it exists so repeated runs share one history. */
async function testUserId() {
  const existing = await clerk(
    `/users?email_address=${encodeURIComponent(EMAIL)}`,
  );

  if (existing.length > 0) return existing[0].id;

  const created = await clerk("/users", {
    method: "POST",
    body: JSON.stringify({
      email_address: [EMAIL],
      password: PASSWORD,
      skip_password_checks: true,
    }),
  });

  return created.id;
}

/**
 * Clerk sessions expire in about a minute, so the token is minted on demand
 * rather than held — the same thing the browser client does per request.
 */
async function sessionToken(sessionId) {
  const minted = await clerk(`/sessions/${sessionId}/tokens`, {
    method: "POST",
    body: JSON.stringify({ expires_in_seconds: 60 }),
  });

  return minted.jwt;
}

async function api(sessionId, path, init = {}) {
  const token = await sessionToken(sessionId);
  const response = await fetch(`${BACKEND}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-session-id": SMOKE_SESSION_ID,
      ...init.headers,
    },
  });

  const body = await response.text();
  let parsed = null;

  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = { raw: body.slice(0, 400) };
  }

  return { status: response.status, body: parsed };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const prompt =
    process.argv[2] ??
    "Crop the image at https://picsum.photos/id/237/800/600 to its centre square.";

  step("health");
  const health = await fetch(`${BACKEND}/api/v1/health`);
  console.log("  ", health.status, (await health.text()).slice(0, 120));
  assert(health.status === 200, "health did not return 200");

  step("clerk test user", EMAIL);
  const userId = await testUserId();
  const session = await clerk("/sessions", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  console.log("  test session minted");

  step("unauthenticated /chats must be 401");
  const anon = await fetch(`${BACKEND}/api/v1/chats`);
  console.log("  ", anon.status, anon.status === 401 ? "OK" : "UNEXPECTED");
  assert(anon.status === 401, "unauthenticated chats did not return 401");

  step("GET /chats");
  const chats = await api(session.id, "/chats");
  console.log("  ", chats.status, JSON.stringify(chats.body).slice(0, 200));
  assert(
    chats.status === 200 &&
      Array.isArray(chats.body?.items) &&
      typeof chats.body?.hasMore === "boolean" &&
      (typeof chats.body?.nextCursor === "string" ||
        chats.body?.nextCursor === null),
    "chat list did not return the cursor envelope",
  );

  step("Zod rejection must not leak field names");
  const invalid = await api(session.id, "/messages", {
    method: "POST",
    body: JSON.stringify({
      content: "",
      idempotencyKey: "smoke-invalid-key",
      attachmentIds: [],
    }),
  });
  const invalidJson = JSON.stringify(invalid.body);
  console.log("  ", invalid.status, invalidJson.slice(0, 300));
  assert(invalid.status === 400, "invalid message did not return 400");
  assert(
    !["content", "idempotencyKey", "attachmentIds"].some((field) =>
      invalidJson.includes(field),
    ),
    "validation response leaked a request field name",
  );

  step("POST /messages", prompt);
  const send = await api(session.id, "/messages", {
    method: "POST",
    body: JSON.stringify({
      content: prompt,
      idempotencyKey: `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      attachmentIds: [],
    }),
  });
  console.log("  ", send.status, {
    chatId: send.body?.chatId,
    runId: send.body?.runId,
    realtimeRunIdPresent: typeof send.body?.realtimeRunId === "string",
    realtimeTokenPresent: typeof send.body?.realtimeToken === "string",
  });

  if (send.status !== 202 && send.status !== 200) {
    throw new Error("send did not start a run");
  }

  const { chatId, runId } = send.body;

  step("poll run", `${chatId} / ${runId}`);
  let last = "";
  let terminalStatus = null;
  const answeredWaitpoints = new Set();

  for (let i = 0; i < 90; i += 1) {
    const run = await api(session.id, `/chats/${chatId}/runs/${runId}`);
    const status = run.body?.status ?? `HTTP ${run.status}`;

    if (status !== last) {
      console.log(`   [${i * 2}s] ${status}`);
      last = status;
    }

    if (status === "WAITING") {
      const waitpoint = await api(session.id, `/runs/${runId}/waitpoint`);
      assert(waitpoint.status === 200, "waiting run had no waitpoint");
      const plan = waitpoint.body?.payload;
      const waitpointId = waitpoint.body?.id;

      console.log("   PLAN CARD:", JSON.stringify(plan, null, 2));

      if (!answeredWaitpoints.has(waitpointId)) {
        const resolve = await api(
          session.id,
          `/waitpoints/${waitpointId}/resolve`,
          {
            method: "POST",
            body: JSON.stringify({
              resolution: "RUN_ALL",
              idempotencyKey: `smoke-decision-${waitpointId}`,
            }),
          },
        );

        console.log("   approved →", resolve.status, resolve.body?.status);
        assert(resolve.status === 200, "plan approval failed");
        answeredWaitpoints.add(waitpointId);
      }
    }

    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) {
      terminalStatus = status;
      break;
    }

    await sleep(2_000);
  }
  assert(
    terminalStatus === "COMPLETED",
    `run ended as ${terminalStatus ?? "timeout"}`,
  );

  step("message history");
  const messages = await api(session.id, `/chats/${chatId}/messages?limit=10`);
  console.log(JSON.stringify(messages.body, null, 2).slice(0, 4000));
  assert(messages.status === 200, "message history failed");
  const rows = messages.body?.items ?? [];
  assert(
    rows.some(
      (message) => message.role === "USER" && message.content === prompt,
    ),
    "persisted user message missing",
  );
  assert(
    rows.some(
      (message) =>
        message.role === "ASSISTANT" &&
        message.runId === runId &&
        message.status === "SUCCESS",
    ),
    "persisted successful assistant message missing",
  );

  step("credit ledger");
  const ledger = await api(session.id, "/credits/ledger?limit=10");
  console.log(JSON.stringify(ledger.body, null, 2).slice(0, 2000));
  assert(ledger.status === 200, "credit ledger failed");

  const smokeTitle = `Prod smoke ${Date.now()}`;
  step("pin + rename + search chat");
  const updated = await api(session.id, `/chats/${chatId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: smokeTitle, pinned: true }),
  });
  assert(
    updated.status === 200 &&
      updated.body?.title === smokeTitle &&
      updated.body?.pinned === true,
    "pin/rename failed",
  );
  const found = await api(
    session.id,
    `/chats?q=${encodeURIComponent(smokeTitle)}`,
  );
  assert(
    found.status === 200 &&
      found.body?.items?.some((chat) => chat.id === chatId && chat.pinned),
    "chat search did not find the pinned rename",
  );
  console.log("   PATCH 200; search found pinned chat");

  step("soft-delete chat");
  const deleted = await api(session.id, `/chats/${chatId}`, {
    method: "DELETE",
  });
  assert(
    deleted.status === 200 && deleted.body?.deleted === true,
    "chat delete failed",
  );
  const hidden = await api(
    session.id,
    `/chats?q=${encodeURIComponent(smokeTitle)}`,
  );
  assert(
    hidden.status === 200 &&
      !hidden.body?.items?.some((chat) => chat.id === chatId),
    "soft-deleted chat remained visible",
  );
  console.log("   deleted chat hidden from search");

  console.log(`\nSMOKE PASSED chatId=${chatId} runId=${runId}`);
}

main().catch((error) => {
  console.error("\nSMOKE FAILED:", error.message);
  process.exit(1);
});
