/**
 * Reads JSON without letting syntax errors escape into the generic 500 path.
 *
 * `undefined` is intentionally fed to each route's Zod schema, which then
 * produces the same redacted 400 envelope as any other invalid body.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => undefined);
}
