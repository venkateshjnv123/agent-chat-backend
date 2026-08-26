import { z } from "zod";

/**
 * Media attachments, uploaded through Transloadit.
 *
 * The browser never holds our Transloadit secret. It asks the backend to sign a
 * set of Assembly parameters, uploads directly to Transloadit with them, and
 * then tells us which Assembly it started. We verify the outcome with
 * Transloadit ourselves rather than trusting what the client reports, because
 * the resulting URL is fed to a paid tool and to the model.
 */

export const AttachmentStatusSchema = z.enum([
  "PENDING",
  "UPLOADING",
  "READY",
  "FAILED",
]);

export const ACCEPTED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
] as const;

/** Reviewer policy: 0.5 GiB per file and 5 GiB signed per UTC month. */
export const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export const MONTHLY_ATTACHMENT_BYTES = 5 * 1024 * 1024 * 1024;

export const SignUploadRequestSchema = z.object({
  /** Optional: an attachment can be prepared before the chat exists. */
  chatId: z.string().min(1).optional(),
  filename: z.string().min(1).max(255),
  mimeType: z.enum(ACCEPTED_MIME_TYPES),
  fileSize: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
});

/**
 * What the browser needs to upload, and nothing more.
 *
 * `params` is the exact JSON string that was signed — re-serialising it in the
 * client would change the bytes and invalidate the signature, so it travels as
 * a string rather than as an object.
 */
export const SignUploadResponseSchema = z.object({
  attachmentId: z.string(),
  uploadUrl: z.url(),
  params: z.string(),
  signature: z.string(),
  expiresAt: z.string(),
});

export const CompleteUploadRequestSchema = z.object({
  assemblyId: z.string().min(1).max(128),
});

export const AttachmentSchema = z.object({
  id: z.string(),
  status: AttachmentStatusSchema,
  filename: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Public HTTPS URL. Null until the Assembly completes. */
  url: z.url().nullable(),
  order: z.number().int(),
  createdAt: z.string(),
  /** User-safe copy when the upload failed. */
  userMessage: z.string().nullable().default(null),
});

export const AttachmentListResponseSchema = z.object({
  items: z.array(AttachmentSchema),
});

export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;
export type SignUploadRequest = z.infer<typeof SignUploadRequestSchema>;
export type SignUploadResponse = z.infer<typeof SignUploadResponseSchema>;
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequestSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type AttachmentListResponse = z.infer<
  typeof AttachmentListResponseSchema
>;
