import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signed image uploads (PLAN.md 3.15).
 *
 * The bytes never pass through this server, so the security of the whole path
 * rests on two things: the parameters we sign, and refusing to believe what the
 * browser reports about the outcome. Both are asserted here.
 */

type Row = {
  id: string;
  ownerId: string;
  chatId: string | null;
  messageId: string | null;
  assemblyId: string | null;
  status: "PENDING" | "UPLOADING" | "READY" | "FAILED";
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  filename: string | null;
  resultUrl: string | null;
  userMessage: string | null;
  order: number;
  createdAt: Date;
};

let rows: Row[];
let quotaUsed: bigint;

function blank(id: string, ownerId = "user_a"): Row {
  return {
    id,
    ownerId,
    chatId: null,
    messageId: null,
    assemblyId: null,
    status: "PENDING",
    mimeType: "image/png",
    fileSize: 1_000,
    width: null,
    height: null,
    filename: "cat.png",
    resultUrl: null,
    userMessage: null,
    order: 0,
    createdAt: new Date(),
  };
}

const attachment = {
  create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
    const row = { ...blank(`att_${rows.length + 1}`), ...data } as Row;
    rows.push(row);
    return row;
  }),
  findFirst: vi.fn(
    async ({ where }: { where: { id: string; ownerId: string } }) =>
      rows.find((r) => r.id === where.id && r.ownerId === where.ownerId) ??
      null,
  ),
  findMany: vi.fn(
    async ({
      where,
    }: {
      where: {
        id?: { in: string[] };
        ownerId: string;
        status?: string;
      };
    }) =>
      rows.filter(
        (r) =>
          r.ownerId === where.ownerId &&
          (!where.id || where.id.in.includes(r.id)) &&
          (!where.status || r.status === where.status),
      ),
  ),
  update: vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  ),
  updateMany: vi.fn(async () => ({ count: 0 })),
};

const chat = {
  findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
    where.userId === "user_a" ? { id: "chat_1" } : null,
  ),
};

const prisma = {
  attachment,
  chat,
  $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
    strings.join("").includes("SUM")
      ? [{ used: quotaUsed }]
      : [{ pg_advisory_xact_lock: null }],
  ),
  $transaction: vi.fn(async (body: (tx: unknown) => unknown) => body(prisma)),
};

vi.mock("@/db/client", () => ({ prisma }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

process.env.TRANSLOADIT_AUTH_KEY = "test_key";
process.env.TRANSLOADIT_AUTH_SECRET = "test_secret";

const { signUpload, transloaditDate } =
  await import("@/attachments/transloadit");
const { MAX_ATTACHMENT_BYTES, MONTHLY_ATTACHMENT_BYTES } =
  await import("@/contracts/attachments");
const {
  AttachmentError,
  completeUpload,
  createSignedUpload,
  resolveReadyAttachments,
} = await import("@/services/attachments");

function assemblyResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  rows = [];
  quotaUsed = 0n;
  vi.clearAllMocks();
});

describe("signing", () => {
  it("signs the exact bytes the client must send back", () => {
    const signed = signUpload({ attachmentId: "att_1", ownerId: "user_a" });
    const expected = createHmac("sha384", "test_secret")
      .update(signed.params)
      .digest("hex");

    expect(signed.signature).toBe(`sha384:${expected}`);
    // Re-serialising the JSON changes the bytes and invalidates the signature,
    // which is why params travels to the client as a string.
    expect(signed.signature).not.toBe(
      `sha384:${createHmac("sha384", "test_secret")
        .update(JSON.stringify(JSON.parse(signed.params)) + " ")
        .digest("hex")}`,
    );
  });

  it("never puts the secret in what the client receives", () => {
    const signed = signUpload({ attachmentId: "att_1", ownerId: "user_a" });

    expect(signed.params).not.toContain("test_secret");
    expect(signed.signature).not.toContain("test_secret");
    // The auth key is public by design; the secret is what must not travel.
    expect(signed.params).toContain("test_key");
  });

  it("constrains the upload to supported media under the size cap", () => {
    const params = JSON.parse(
      signUpload({ attachmentId: "att_1", ownerId: "user_a" }).params,
    );

    // The client's file picker is a convenience; this step is the control. A
    // browser can post any bytes it likes to the upload URL.
    expect(params.steps.filtered.robot).toBe("/file/filter");
    expect(params.steps.filtered.error_on_decline).toBe(true);
    // Transloadit ORs conditions by default, which accepts a tiny shell script
    // because it satisfies the size rule. Verified against the live API.
    expect(params.steps.filtered.condition_type).toBe("and");
    expect(JSON.stringify(params.steps.filtered.accepts)).toContain(
      "image/png",
    );
    expect(JSON.stringify(params.steps.filtered.accepts)).toContain(
      "video/mp4",
    );
    expect(JSON.stringify(params.steps.filtered.accepts)).toContain(
      "audio/mpeg",
    );
    expect(JSON.stringify(params.steps.filtered.accepts)).toContain(
      String(MAX_ATTACHMENT_BYTES),
    );
  });

  it("does not resize, because the only available strategy upscales", () => {
    const params = JSON.parse(
      signUpload({ attachmentId: "att_1", ownerId: "user_a" }).params,
    );

    // Verified against the live API: /image/resize with resize_strategy "fit"
    // turns a 1x1 pixel into 2048x2048. Inflating a small image costs bytes
    // and fidelity for nothing.
    expect(JSON.stringify(params.steps)).not.toContain("/image/resize");
  });

  it("expires the signature in Transloadit's own date format", () => {
    const signed = signUpload({ attachmentId: "att_1", ownerId: "user_a" });
    const params = JSON.parse(signed.params);

    // An ISO string is rejected, and the rejection reads as a signature
    // mismatch, which is an hour to trace.
    expect(params.auth.expires).toMatch(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\+00:00$/,
    );
    expect(params.auth.expires).toBe(transloaditDate(signed.expiresAt));
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses to prepare an upload against someone else's chat", async () => {
    await expect(
      createSignedUpload({
        ownerId: "user_b",
        chatId: "chat_1",
        filename: "cat.png",
        mimeType: "image/png",
        fileSize: 1_000,
      }),
    ).rejects.toBeInstanceOf(AttachmentError);

    expect(attachment.create).not.toHaveBeenCalled();
  });

  it("serialises and refuses a monthly quota overrun", async () => {
    quotaUsed = BigInt(MONTHLY_ATTACHMENT_BYTES - 100);

    await expect(
      createSignedUpload({
        ownerId: "user_a",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        fileSize: 101,
      }),
    ).rejects.toMatchObject({ code: "monthly_upload_quota", status: 429 });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(attachment.create).not.toHaveBeenCalled();
  });
});

describe("completion", () => {
  const COMPLETED = {
    ok: "ASSEMBLY_COMPLETED",
    assembly_id: "asm_1",
    fields: { attachmentId: "att_1", ownerId: "user_a" },
    results: {
      filtered: [
        {
          ssl_url: "https://tmp.transloadit.com/att_1.png",
          mime: "image/png",
          size: 900,
          meta: { width: 512, height: 512 },
        },
      ],
    },
  };

  const call = {
    ownerId: "user_a",
    attachmentId: "att_1",
    assemblyId: "asm_1",
  };

  beforeEach(() => {
    rows = [blank("att_1")];
  });

  it("takes the file's real facts from Transloadit, not from the client", async () => {
    fetchMock.mockResolvedValue(assemblyResponse(COMPLETED));

    const result = await completeUpload(call);

    expect(result).toMatchObject({
      status: "READY",
      url: "https://tmp.transloadit.com/att_1.png",
      width: 512,
      height: 512,
      fileSize: 900,
    });
  });

  it("refuses an Assembly that was signed for a different attachment", async () => {
    fetchMock.mockResolvedValue(
      assemblyResponse({
        ...COMPLETED,
        fields: { attachmentId: "att_someone_else", ownerId: "user_b" },
      }),
    );

    // Without this check any caller could point their own row at somebody
    // else's uploaded file, and that URL is handed to a paid tool.
    await expect(completeUpload(call)).rejects.toMatchObject({
      code: "assembly_mismatch",
    });
    expect(rows[0].status).toBe("PENDING");
  });

  it("hides someone else's attachment behind the same answer as a missing one", async () => {
    await expect(
      completeUpload({ ...call, ownerId: "user_b" }),
    ).rejects.toMatchObject({ code: "attachment_not_found" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a declined file as failed rather than leaving it uploading", async () => {
    fetchMock.mockResolvedValue(
      assemblyResponse({
        ok: "ASSEMBLY_ERROR",
        assembly_id: "asm_1",
        fields: { attachmentId: "att_1", ownerId: "user_a" },
        error: "INVALID_FILE_META_DATA",
      }),
    );

    const result = await completeUpload(call);

    expect(result.status).toBe("FAILED");
    expect(result.userMessage).toContain("image, video, or audio");
    expect(result.url).toBeNull();
    expect(rows[0].userMessage).toBe(result.userMessage);
  });

  it("reports a still-running Assembly without settling it", async () => {
    fetchMock.mockResolvedValue(
      assemblyResponse({
        ok: "ASSEMBLY_EXECUTING",
        assembly_id: "asm_1",
        fields: { attachmentId: "att_1", ownerId: "user_a" },
      }),
    );

    expect(await completeUpload(call)).toMatchObject({ status: "UPLOADING" });
  });

  it("answers a duplicate confirmation from the row instead of asking again", async () => {
    fetchMock.mockResolvedValue(assemblyResponse(COMPLETED));

    await completeUpload(call);
    const second = await completeUpload(call);

    expect(second.status).toBe("READY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails the attachment when the upload service cannot be reached", async () => {
    fetchMock.mockResolvedValue(assemblyResponse({}, 503));

    const failed = await completeUpload(call);

    expect(failed).toMatchObject({ status: "FAILED" });
    expect(rows[0].userMessage).toBe(failed.userMessage);

    fetchMock.mockResolvedValue(assemblyResponse(COMPLETED));

    await expect(completeUpload(call)).resolves.toMatchObject({
      status: "READY",
      userMessage: null,
    });
  });
});

describe("attaching to a send", () => {
  beforeEach(() => {
    rows = [
      { ...blank("att_1"), status: "READY", resultUrl: "https://cdn/1.png" },
      { ...blank("att_2"), status: "READY", resultUrl: "https://cdn/2.png" },
      { ...blank("att_3"), status: "UPLOADING" },
      {
        ...blank("att_4", "user_b"),
        status: "READY",
        resultUrl: "https://cdn/4.png",
      },
    ];
  });

  it("keeps the order the client listed, not creation order", async () => {
    const resolved = await resolveReadyAttachments({
      ownerId: "user_a",
      attachmentIds: ["att_2", "att_1"],
    });

    // "crop the second one" has to mean the same image the user reordered.
    expect(resolved.map((entry) => entry.url)).toEqual([
      "https://cdn/2.png",
      "https://cdn/1.png",
    ]);
  });

  it("rejects a send naming an attachment that is still uploading", async () => {
    await expect(
      resolveReadyAttachments({
        ownerId: "user_a",
        attachmentIds: ["att_1", "att_3"],
      }),
    ).rejects.toMatchObject({ code: "attachment_not_ready" });
  });

  it("rejects a send naming someone else's attachment", async () => {
    await expect(
      resolveReadyAttachments({
        ownerId: "user_a",
        attachmentIds: ["att_4"],
      }),
    ).rejects.toBeInstanceOf(AttachmentError);
  });
});
