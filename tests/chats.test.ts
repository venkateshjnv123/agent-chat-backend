import { beforeEach, describe, expect, it, vi } from "vitest";

type ChatRow = {
  id: string;
  userId: string;
  title: string | null;
  modelId: string;
  pinned: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

let rows: ChatRow[];
let activeRun: string | null;

const chat = {
  findFirst: vi.fn(
    async ({
      where,
    }: {
      where: { id: string; userId: string; deletedAt?: null };
    }) =>
      rows.find(
        (row) =>
          row.id === where.id &&
          row.userId === where.userId &&
          (where.deletedAt !== null || row.deletedAt === null),
      ) ?? null,
  ),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<ChatRow>;
    }) => {
      const row = rows.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  ),
};

const agentRun = {
  findFirst: vi.fn(async () => (activeRun ? { id: activeRun } : null)),
};

const prisma = {
  chat,
  agentRun,
  $transaction: vi.fn(
    async (
      work: (tx: { chat: typeof chat; agentRun: typeof agentRun }) => unknown,
    ) => work({ chat, agentRun }),
  ),
};

vi.mock("@/db/client", () => ({ prisma }));

const { ChatMutationError, softDeleteOwnedChat, updateOwnedChat } =
  await import("@/services/chats");

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    id: "chat_1",
    userId: "owner_a",
    title: "Old title",
    modelId: "openrouter/free",
    pinned: false,
    deletedAt: null,
    createdAt: new Date("2026-08-26T00:00:00Z"),
    updatedAt: new Date("2026-08-26T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  rows = [row()];
  activeRun = null;
  vi.clearAllMocks();
});

describe("chat mutation ownership", () => {
  it("does not reveal another owner's chat", async () => {
    await expect(
      updateOwnedChat("owner_b", "chat_1", { pinned: true }),
    ).rejects.toBeInstanceOf(ChatMutationError);

    expect(chat.update).not.toHaveBeenCalled();
  });

  it("treats a deleted chat as missing for updates", async () => {
    rows[0].deletedAt = new Date();

    await expect(
      updateOwnedChat("owner_a", "chat_1", { title: "New" }),
    ).rejects.toMatchObject({ code: "chat_not_found", status: 404 });
  });
});

describe("idempotency", () => {
  it("does not reshuffle updatedAt for a repeated rename/pin", async () => {
    const unchanged = await updateOwnedChat("owner_a", "chat_1", {
      title: "Old title",
      pinned: false,
    });

    expect(unchanged).toBe(rows[0]);
    expect(chat.update).not.toHaveBeenCalled();
  });

  it("returns success when delete is repeated", async () => {
    expect(await softDeleteOwnedChat("owner_a", "chat_1")).toEqual({
      id: "chat_1",
      deleted: true,
    });
    expect(await softDeleteOwnedChat("owner_a", "chat_1")).toEqual({
      id: "chat_1",
      deleted: true,
    });

    expect(chat.update).toHaveBeenCalledTimes(1);
  });
});

describe("safe delete", () => {
  it("refuses to hide controls while a run is active", async () => {
    activeRun = "run_1";

    await expect(
      softDeleteOwnedChat("owner_a", "chat_1"),
    ).rejects.toMatchObject({ code: "chat_active", status: 409 });

    expect(chat.update).not.toHaveBeenCalled();
  });

  it("soft deletes and unpins, preserving the row", async () => {
    rows[0].pinned = true;

    await softDeleteOwnedChat("owner_a", "chat_1");

    expect(rows[0].deletedAt).toBeInstanceOf(Date);
    expect(rows[0].pinned).toBe(false);
    expect(rows).toHaveLength(1);
  });
});
