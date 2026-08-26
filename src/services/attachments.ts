import {
  MONTHLY_ATTACHMENT_BYTES,
  type Attachment,
} from "@/contracts/attachments";
import { prisma } from "@/db/client";
import type { Attachment as AttachmentRow } from "@/generated/prisma/client";
import {
  TransloaditError,
  getAssembly,
  isAssemblyComplete,
  isAssemblyTerminal,
  signUpload,
  type SignedUpload,
} from "@/attachments/transloadit";

/**
 * Attachment lifecycle: sign, upload, verify, attach.
 *
 * The row is created before the browser is given a signature, so an upload that
 * is abandoned halfway leaves a PENDING row rather than an orphan file nobody
 * can account for. Every state the user can observe has a row behind it.
 */

export class AttachmentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
    this.status = status;
  }
}

export async function createSignedUpload(input: {
  ownerId: string;
  chatId?: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}): Promise<{ attachmentId: string; signed: SignedUpload }> {
  const attachment = await prisma.$transaction(async (tx) => {
    // Serialises quota decisions for this owner across serverless instances.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.ownerId}, 1))`;

    // Claiming the chat here means an attachment can never be prepared against
    // somebody else's conversation, even though the bytes bypass this server.
    if (input.chatId) {
      const chat = await tx.chat.findFirst({
        where: {
          id: input.chatId,
          userId: input.ownerId,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!chat) throw new AttachmentError("chat_not_found", "chat", 404);
    }

    const monthStartedAt = new Date();

    monthStartedAt.setUTCDate(1);
    monthStartedAt.setUTCHours(0, 0, 0, 0);

    // A signature dies after 15 minutes. Releasing untouched PENDING rows a
    // little later prevents abandoned browser tabs consuming quota forever.
    await tx.attachment.updateMany({
      where: {
        ownerId: input.ownerId,
        status: "PENDING",
        createdAt: { lt: new Date(Date.now() - 20 * 60 * 1_000) },
      },
      data: {
        status: "FAILED",
        userMessage: "This upload expired before it started. Try again.",
      },
    });

    const quota = await tx.$queryRaw<{ used: bigint }[]>`
      SELECT COALESCE(SUM("fileSize"), 0)::bigint AS used
      FROM "Attachment"
      WHERE "ownerId" = ${input.ownerId}
        AND "createdAt" >= ${monthStartedAt}
        AND "status" <> 'FAILED'
    `;
    const used = Number(quota[0]?.used ?? 0n);

    if (used + input.fileSize > MONTHLY_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        "monthly_upload_quota",
        "Monthly upload quota reached.",
        429,
      );
    }

    return tx.attachment.create({
      data: {
        ownerId: input.ownerId,
        chatId: input.chatId ?? null,
        filename: input.filename,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        status: "PENDING",
      },
      select: { id: true },
    });
  });

  return {
    attachmentId: attachment.id,
    signed: signUpload({
      attachmentId: attachment.id,
      ownerId: input.ownerId,
    }),
  };
}

/**
 * Confirms an upload against Transloadit.
 *
 * Two checks matter here and neither can be skipped. Ownership, because an
 * attachment id is not a secret. And the `fields.attachmentId` echo, because
 * the client supplies the Assembly id: without it, anyone could point their own
 * attachment row at somebody else's uploaded file, and that URL is handed to a
 * paid tool and to the model.
 */
export async function completeUpload(input: {
  ownerId: string;
  attachmentId: string;
  assemblyId: string;
}): Promise<Attachment> {
  const row = await prisma.attachment.findFirst({
    where: { id: input.attachmentId, ownerId: input.ownerId },
  });

  if (!row) throw new AttachmentError("attachment_not_found", "gone", 404);

  // Confirming a completed upload twice is a duplicate click, not an error.
  // FAILED is deliberately retried: a previous provider/network failure may be
  // transient, and the durable row retains its safe copy while the retry runs.
  if (row.status === "READY") return serialize(row);

  let assembly;

  try {
    assembly = await getAssembly(input.assemblyId);
  } catch (error) {
    if (error instanceof TransloaditError) {
      return serialize(
        await markFailed(row.id, error.userMessage, input.assemblyId),
      );
    }

    throw error;
  }

  if (assembly.fields.attachmentId !== row.id) {
    // The caller named an Assembly that was not signed for this attachment.
    throw new AttachmentError("assembly_mismatch", "mismatch", 403);
  }

  if (!isAssemblyTerminal(assembly.ok)) {
    await prisma.attachment.update({
      where: { id: row.id },
      data: { status: "UPLOADING", assemblyId: assembly.assemblyId },
    });

    return serialize({ ...row, status: "UPLOADING" });
  }

  if (!isAssemblyComplete(assembly.ok) || !assembly.url) {
    // A file the filter step declined lands here: the Assembly is terminal and
    // produced nothing, which is exactly what we asked it to do.
    return serialize(
      await markFailed(
        row.id,
        "That file was rejected. Use supported image, video, or audio media under 512 MiB.",
        assembly.assemblyId,
      ),
    );
  }

  const updated = await prisma.attachment.update({
    where: { id: row.id },
    data: {
      status: "READY",
      assemblyId: assembly.assemblyId,
      // Trusted from Transloadit, not from the browser: these describe the file
      // that actually exists.
      resultUrl: assembly.url,
      userMessage: null,
      mimeType: assembly.mimeType ?? row.mimeType,
      fileSize: assembly.fileSize ?? row.fileSize,
      width: assembly.width,
      height: assembly.height,
    },
  });

  return serialize(updated);
}

/**
 * Resolves the attachments a send names, before anything is written.
 *
 * Order is the order the client listed them, not creation order: a user who
 * reorders thumbnails before sending expects the model to see that order, and
 * for chained tool work the order is the meaning.
 *
 * Only READY rows the caller owns resolve. A half-uploaded attachment must not
 * reach the model as a URL that does not resolve, and someone else's upload
 * must not resolve at all. This runs before the message row exists so a bad
 * reference is a rejected request rather than a persisted broken turn.
 */
export async function resolveReadyAttachments(input: {
  ownerId: string;
  attachmentIds: string[];
}): Promise<{ id: string; url: string }[]> {
  if (input.attachmentIds.length === 0) return [];

  const rows = await prisma.attachment.findMany({
    where: {
      id: { in: input.attachmentIds },
      ownerId: input.ownerId,
      status: "READY",
    },
    select: { id: true, resultUrl: true },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));

  if (byId.size !== new Set(input.attachmentIds).size) {
    throw new AttachmentError(
      "attachment_not_ready",
      "one or more attachments are missing or still uploading",
    );
  }

  return input.attachmentIds.map((id) => ({
    id,
    url: byId.get(id)!.resultUrl!,
  }));
}

export async function listAttachments(
  ownerId: string,
  limit = 50,
): Promise<Attachment[]> {
  const rows = await prisma.attachment.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map(serialize);
}

/** Persists the safe copy so reload and retry show the same explanation. */
async function markFailed(
  id: string,
  userMessage: string,
  assemblyId?: string,
): Promise<AttachmentRow & { userMessage: string }> {
  const row = await prisma.attachment.update({
    where: { id },
    data: {
      status: "FAILED",
      userMessage,
      ...(assemblyId ? { assemblyId } : {}),
    },
  });

  return { ...row, userMessage };
}

function serialize(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    status: row.status,
    filename: row.filename,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    width: row.width,
    height: row.height,
    url: row.resultUrl,
    order: row.order,
    createdAt: row.createdAt.toISOString(),
    userMessage:
      row.userMessage ??
      (row.status === "FAILED" ? "That upload did not finish." : null),
  };
}
