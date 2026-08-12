import { createHash, randomBytes } from "node:crypto";

export function createSessionToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: digestSessionToken(token) };
}

export function digestSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
