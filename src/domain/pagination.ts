export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface PageRequest {
  limit?: number;
  cursor?: string | null;
}

export interface SortCursor {
  timestamp: number;
  id: string;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

export function pageLimit(value: number | undefined, fallback = 50): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(value)));
}

export function encodeCursor(cursor: SortCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string | null | undefined): SortCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "timestamp" in parsed &&
      "id" in parsed &&
      typeof parsed.timestamp === "number" &&
      Number.isFinite(parsed.timestamp) &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0
    ) {
      return { timestamp: parsed.timestamp, id: parsed.id };
    }
  } catch {
    // Converted to a stable domain error below.
  }
  throw new InvalidCursorError();
}

export class InvalidCursorError extends Error {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("The pagination cursor is malformed.");
    this.name = "InvalidCursorError";
  }
}
