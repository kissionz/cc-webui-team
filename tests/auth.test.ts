import { pbkdf2Sync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { createSessionToken, digestSessionToken } from "../src/auth/session-token.js";
import { FixedWindowRateLimiter } from "../src/http/rate-limit.js";

describe("authentication primitives", () => {
  it("hashes new passwords with scrypt and verifies them", async () => {
    const stored = await hashPassword("correct horse battery staple");

    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect((await verifyPassword("incorrect", stored)).valid).toBe(false);
  });

  it("accepts legacy PBKDF2 hashes only for immediate rehash", async () => {
    const salt = "00112233445566778899aabbccddeeff";
    const digest = pbkdf2Sync("legacy-password", salt, 120_000, 32, "sha256").toString("hex");

    expect(await verifyPassword("legacy-password", `${salt}:${digest}`)).toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it("stores only a deterministic digest of random bearer tokens", () => {
    const created = createSessionToken();

    expect(created.token).not.toBe(created.digest);
    expect(created.digest).toBe(digestSessionToken(created.token));
    expect(created.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("bounds rate-limit keys and resets expired windows", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 100, maxKeys: 2, now: () => now });

    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    expect(limiter.consume("b").allowed).toBe(true);
    expect(limiter.consume("c").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);
    now += 101;
    expect(limiter.consume("a").allowed).toBe(true);
  });
});
