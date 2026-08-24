/**
 * Cursors are opaque to the client and encode the sort key we actually page on.
 *
 * Chats page on (updatedAt, id); messages page on the epoch-millis sequence.
 * Neither uses skip/take — an offset re-reads rows the user already saw when
 * anything is inserted mid-scroll.
 */
export function encodeCursor(parts: (string | number | bigint)[]): string {
  return Buffer.from(parts.map(String).join("|"), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string[] | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");

    return decoded.length > 0 ? decoded.split("|") : null;
  } catch {
    return null;
  }
}

export function decodeSequenceCursor(cursor: string): bigint | null {
  const parts = decodeCursor(cursor);

  if (!parts || parts.length !== 1) return null;

  try {
    return BigInt(parts[0]);
  } catch {
    return null;
  }
}

export function decodeChatCursor(
  cursor: string,
): { updatedAt: Date; id: string } | null {
  const parts = decodeCursor(cursor);

  if (!parts || parts.length !== 2) return null;

  const updatedAt = new Date(parts[0]);

  return Number.isNaN(updatedAt.getTime()) ? null : { updatedAt, id: parts[1] };
}
