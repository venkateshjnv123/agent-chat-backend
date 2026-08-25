import { createHmac } from "node:crypto";

import {
  ACCEPTED_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
} from "@/contracts/attachments";
import { readRequiredEnv } from "@/env/server";

/**
 * Transloadit Assembly signing and status.
 *
 * The secret never leaves this process. The browser receives a signature over
 * one specific set of parameters — bounded in time, restricted to images, and
 * capped in size — and can do nothing with it except the upload we authorised.
 * That is the point of signing on the server: an unsigned or client-signed
 * Assembly would let anyone run arbitrary robots on our account.
 */

const API_BASE = "https://api2.transloadit.com";
const UPLOAD_URL = `${API_BASE}/assemblies`;

/** How long a signed parameter set stays usable. */
const SIGNATURE_TTL_MS = 15 * 60 * 1000;

export type SignedUpload = {
  uploadUrl: string;
  params: string;
  signature: string;
  expiresAt: Date;
};

export class TransloaditError extends Error {
  readonly code: string;
  readonly userMessage: string;

  constructor(options: { code: string; message: string; userMessage: string }) {
    super(options.message);
    this.name = "TransloaditError";
    this.code = options.code;
    this.userMessage = options.userMessage;
  }
}

function credentials() {
  const { TRANSLOADIT_AUTH_KEY, TRANSLOADIT_AUTH_SECRET } = readRequiredEnv([
    "TRANSLOADIT_AUTH_KEY",
    "TRANSLOADIT_AUTH_SECRET",
  ]);

  return { key: TRANSLOADIT_AUTH_KEY, secret: TRANSLOADIT_AUTH_SECRET };
}

/**
 * Transloadit's expiry format is UTC, `YYYY/MM/DD HH:mm:ss+00:00`.
 *
 * An ISO string is rejected, and the rejection reads as a signature mismatch,
 * so the formatting is done here rather than at a call site.
 */
export function transloaditDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`
  );
}

/**
 * The Steps the upload is allowed to run.
 *
 * Declared inline and signed rather than kept in a dashboard template: the
 * pipeline is then visible in the repository next to the code that depends on
 * it, and a change to it goes through review like anything else.
 *
 * `/file/filter` is the security control, not the client's file picker. A
 * browser can send any bytes it likes to the upload URL; this step is what
 * stops a video or an executable becoming an attachment we then hand to a paid
 * tool. The size cap is enforced the same way, for the same reason.
 *
 * There is deliberately no resize step. `/image/resize` has no downscale-only
 * strategy — `fit` upscales, verified against the live API by uploading a 1x1
 * pixel and getting 2048x2048 back — and inflating a small image costs bytes
 * and fidelity for nothing. The 10 MB cap already bounds the input, and Magica
 * prices by output size, not by what we send it.
 */
function steps() {
  return {
    ":original": { robot: "/upload/handle" },
    filtered: {
      use: ":original",
      robot: "/file/filter",
      accepts: [
        ["${file.mime}", "regex", `^(${ACCEPTED_MIME_TYPES.join("|")})$`],
        ["${file.size}", "<=", MAX_ATTACHMENT_BYTES],
      ],
      // Transloadit ORs the conditions by default. Left at the default, a 21
      // byte shell script satisfies the size rule and is accepted — verified
      // against the live API before this line existed. Both rules must hold.
      condition_type: "and",
      // A rejected file must fail the Assembly rather than complete it with no
      // results: a silent empty success surfaces as an upload stuck forever.
      error_on_decline: true,
    },
  };
}

/**
 * Signs one upload.
 *
 * `fields` are echoed back on the Assembly, which is how the completion path
 * proves the Assembly it is told about is the one we authorised, rather than
 * any Assembly id the caller happens to know.
 */
export function signUpload(fields: {
  attachmentId: string;
  ownerId: string;
}): SignedUpload {
  const { key, secret } = credentials();
  const expiresAt = new Date(Date.now() + SIGNATURE_TTL_MS);

  const params = JSON.stringify({
    auth: { key, expires: transloaditDate(expiresAt) },
    steps: steps(),
    fields,
  });

  // SHA-384 over the exact parameter bytes. The client must send this string
  // back verbatim; re-serialising the JSON changes the bytes and the signature
  // stops matching.
  const signature = `sha384:${createHmac("sha384", secret).update(params).digest("hex")}`;

  return { uploadUrl: UPLOAD_URL, params, signature, expiresAt };
}

export type AssemblyResult = {
  ok: string;
  assemblyId: string;
  fields: Record<string, unknown>;
  url: string | null;
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
};

const TERMINAL_OK = "ASSEMBLY_COMPLETED";

/** True once the Assembly will not change again. */
export function isAssemblyTerminal(ok: string): boolean {
  return (
    ok === TERMINAL_OK || ok.endsWith("_ERROR") || ok === "REQUEST_ABORTED"
  );
}

export function isAssemblyComplete(ok: string): boolean {
  return ok === TERMINAL_OK;
}

/**
 * Reads one Assembly.
 *
 * Status is read from Transloadit rather than accepted from the browser. The
 * client could otherwise claim any upload succeeded and name any URL, and that
 * URL is handed straight to a billable tool and to the model.
 */
export async function getAssembly(
  assemblyId: string,
  signal?: AbortSignal,
): Promise<AssemblyResult> {
  const startedAt = Date.now();
  const response = await fetch(
    `${API_BASE}/assemblies/${encodeURIComponent(assemblyId)}`,
    { signal },
  );

  // Path, status and duration only — an Assembly body carries signed URLs.
  console.info(
    `[transloadit] GET /assemblies/:id ${response.status} ${Date.now() - startedAt}ms`,
  );

  if (response.status === 404) {
    throw new TransloaditError({
      code: "assembly_not_found",
      message: "assembly not found",
      userMessage: "That upload could not be found.",
    });
  }

  if (!response.ok) {
    throw new TransloaditError({
      code: `transloadit_http_${response.status}`,
      message: `transloadit responded ${response.status}`,
      userMessage: "The upload service is unavailable right now.",
    });
  }

  const body = (await response.json()) as TransloaditAssembly;
  // `filtered` is the only result step. `:original` never appears in results —
  // Transloadit reports results per named step, and the filter is the last one.
  const file = body.results?.filtered?.[0] ?? null;

  return {
    ok: body.ok ?? body.error ?? "UNKNOWN",
    assemblyId: body.assembly_id ?? assemblyId,
    fields: body.fields ?? {},
    url: file?.ssl_url ?? file?.url ?? null,
    mimeType: file?.mime ?? null,
    fileSize: file?.size ?? null,
    width: file?.meta?.width ?? null,
    height: file?.meta?.height ?? null,
    error: body.error ?? null,
  };
}

type TransloaditAssembly = {
  ok?: string;
  error?: string;
  assembly_id?: string;
  fields?: Record<string, unknown>;
  results?: Record<
    string,
    {
      ssl_url?: string;
      url?: string;
      mime?: string;
      size?: number;
      meta?: { width?: number; height?: number };
    }[]
  >;
};
