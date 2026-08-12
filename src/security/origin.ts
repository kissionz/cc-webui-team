export interface OriginCheckOptions {
  allowMissing?: boolean;
}

export class OriginNotAllowedError extends Error {
  readonly code = "ORIGIN_NOT_ALLOWED";

  constructor(readonly origin: string | undefined) {
    super(origin ? `Origin ${origin} is not allowed.` : "Origin header is required.");
    this.name = "OriginNotAllowedError";
  }
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function isOriginAllowed(
  requestOrigin: string | undefined,
  allowedOrigins: ReadonlyArray<string>,
  options: OriginCheckOptions = {},
): boolean {
  if (!requestOrigin) return options.allowMissing === true;
  const normalizedRequest = normalizeOrigin(requestOrigin);
  if (!normalizedRequest) return false;
  return allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalizedRequest);
}

export function assertAllowedOrigin(
  requestOrigin: string | undefined,
  allowedOrigins: ReadonlyArray<string>,
  options: OriginCheckOptions = {},
): void {
  if (!isOriginAllowed(requestOrigin, allowedOrigins, options)) {
    throw new OriginNotAllowedError(requestOrigin);
  }
}

export function originHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const value = headers.origin;
  return Array.isArray(value) ? value[0] : value;
}
