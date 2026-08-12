import { pbkdf2, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);
const scryptAsync = promisify(scrypt);
const SCRYPT_PREFIX = "scrypt";

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${SCRYPT_PREFIX}$${salt}$${derived.toString("hex")}`;
}

export interface PasswordVerification {
  valid: boolean;
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<PasswordVerification> {
  if (stored.startsWith(`${SCRYPT_PREFIX}$`)) {
    const [, salt, expected] = stored.split("$");
    if (!salt || !expected) return { valid: false, needsRehash: false };
    const derived = (await scryptAsync(password, salt, 64)) as Buffer;
    return { valid: constantTimeHexEqual(derived.toString("hex"), expected), needsRehash: false };
  }

  // Imported v0.2 databases used PBKDF2-SHA256. Successful authentication
  // upgrades the hash immediately, so SQLite never needs a separate migration.
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return { valid: false, needsRehash: false };
  const derived = await pbkdf2Async(password, salt, 120_000, 32, "sha256");
  return {
    valid: constantTimeHexEqual(derived.toString("hex"), expected),
    needsRehash: true,
  };
}
