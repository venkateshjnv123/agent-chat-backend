import {
  AttachmentListResponseSchema,
  SignUploadRequestSchema,
  SignUploadResponseSchema,
} from "@/contracts/attachments";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import {
  AttachmentError,
  createSignedUpload,
  listAttachments,
} from "@/services/attachments";

/**
 * Signs one media upload.
 *
 * The browser uploads straight to Transloadit — the bytes never pass through
 * this server — but the parameters it uploads under are ours, signed here, and
 * restricted to supported media under the size cap. Type and size are checked
 * before signing so an obviously invalid upload is refused without a round trip;
 * the signed `/file/filter` step is what enforces it on the actual bytes.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const parsed = SignUploadRequestSchema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success) {
      return errorResponse("BAD_REQUEST", {
        issues: parsed.error.issues,
        trace,
      });
    }

    try {
      const { attachmentId, signed } = await createSignedUpload({
        ownerId: userAccountId,
        ...parsed.data,
      });

      return jsonResponse(
        SignUploadResponseSchema.parse({
          attachmentId,
          uploadUrl: signed.uploadUrl,
          params: signed.params,
          signature: signed.signature,
          expiresAt: signed.expiresAt.toISOString(),
        }),
        { status: 201, trace },
      );
    } catch (error) {
      if (error instanceof AttachmentError) {
        return errorResponse(
          error.status === 404
            ? "NOT_FOUND"
            : error.status === 429
              ? "RATE_LIMITED"
              : "BAD_REQUEST",
          {
            message:
              error.status === 429
                ? "Monthly upload quota reached."
                : undefined,
            trace,
          },
        );
      }

      throw error;
    }
  });
}

/** The caller's own uploads, newest first — the Media Library's `My Uploads`. */
export async function GET(request: Request) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    return jsonResponse(
      AttachmentListResponseSchema.parse({
        items: await listAttachments(userAccountId),
      }),
      { trace },
    );
  });
}
