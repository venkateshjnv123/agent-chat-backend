import {
  AttachmentSchema,
  CompleteUploadRequestSchema,
} from "@/contracts/attachments";
import { withAuth } from "@/http/context";
import { errorResponse, jsonResponse } from "@/http/errors";
import { AttachmentError, completeUpload } from "@/services/attachments";

/**
 * Confirms an upload once the browser reports its Assembly.
 *
 * What the client says happened is not taken on trust: the Assembly is read
 * back from Transloadit and its echoed `attachmentId` field must match this
 * row. The URL that comes out of here is handed to a billable tool and to the
 * model, so it has to be one we authorised.
 *
 * Still uploading is a 200 with status `UPLOADING`, not an error — the client
 * polls this until it settles.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  return withAuth(request, async ({ userAccountId, trace }) => {
    const { attachmentId } = await context.params;
    const parsed = CompleteUploadRequestSchema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success) {
      return errorResponse("BAD_REQUEST", {
        issues: parsed.error.issues,
        trace,
      });
    }

    try {
      return jsonResponse(
        AttachmentSchema.parse(
          await completeUpload({
            ownerId: userAccountId,
            attachmentId,
            assemblyId: parsed.data.assemblyId,
          }),
        ),
        { trace },
      );
    } catch (error) {
      if (error instanceof AttachmentError) {
        if (error.status === 404) return errorResponse("NOT_FOUND", { trace });
        // A mismatched Assembly is answered as not-found too: a caller probing
        // ids learns nothing about which ones are real.
        if (error.status === 403) return errorResponse("NOT_FOUND", { trace });

        return errorResponse("BAD_REQUEST", { trace });
      }

      throw error;
    }
  });
}
