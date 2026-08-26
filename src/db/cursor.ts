/**
 * Cursors are opaque to the client and encode the sort key we actually page on.
 *
 * Chats page on (pinned, updatedAt, id); messages page on the epoch-millis sequence.
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
): { pinned: boolean; updatedAt: Date; id: string } | null {
  const parts = decodeCursor(cursor);

  // Two-part cursors were issued before pinning existed. Every existing chat
  // was unpinned at migration time, so treating those as `false` preserves an
  // in-flight page across deployment instead of forcing the client to restart.
  if (parts?.length === 2) {
    const updatedAt = new Date(parts[0]);

    return Number.isNaN(updatedAt.getTime())
      ? null
      : { pinned: false, updatedAt, id: parts[1] };
  }

  if (!parts || parts.length !== 3) return null;

  if (parts[0] !== "0" && parts[0] !== "1") return null;

  const updatedAt = new Date(parts[1]);

  return Number.isNaN(updatedAt.getTime())
    ? null
    : { pinned: parts[0] === "1", updatedAt, id: parts[2] };
}
