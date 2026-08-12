import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  InputValidationError,
  assertAllowedOrigin,
  evaluatePermissionDecision,
  object,
  optional,
  resolveAllowedRealPath,
  string,
} from "../src/security/index.js";

test("permission decisions require a pending, unexpired record and known decision", () => {
  const permission = { status: "pending" as const, expiresAt: 2_000 };
  assert.deepEqual(evaluatePermissionDecision(permission, "allow_once", 1_000), {
    ok: true,
    decision: "allow_once",
    status: "approved",
    decidedAt: 1_000,
  });
  assert.equal(evaluatePermissionDecision(permission, "anything", 1_000).ok, false);
  assert.deepEqual(evaluatePermissionDecision(permission, "allow_once", 2_000), {
    ok: false,
    reason: "expired",
    status: "expired",
  });
  assert.deepEqual(
    evaluatePermissionDecision({ status: "approved", expiresAt: 2_000 }, "allow_once", 1_000),
    { ok: false, reason: "already_decided", status: "approved" },
  );
});

test("origin checks use exact normalized HTTP origins", () => {
  assert.doesNotThrow(() => assertAllowedOrigin("https://example.com", ["https://example.com/"]));
  assert.throws(() => assertAllowedOrigin("https://evil.example", ["https://example.com"]));
  assert.throws(() => assertAllowedOrigin(undefined, ["https://example.com"]));
  assert.doesNotThrow(() =>
    assertAllowedOrigin(undefined, ["https://example.com"], { allowMissing: true }),
  );
});

test("realpath allowlist rejects symlink escapes", async () => {
  const base = await mkdtemp(join(tmpdir(), "scheduler-security-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  try {
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, "escape"));

    assert.equal(await resolveAllowedRealPath(root, [root]), await realpath(root));
    await assert.rejects(resolveAllowedRealPath(join(root, "escape"), [root]), {
      code: "PATH_OUTSIDE_ALLOWLIST",
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("object schemas reject unknown fields and report paths", () => {
  const parseUser = object({
    name: string({ trim: true, minLength: 1, maxLength: 20 }),
    email: optional(string({ maxLength: 100 })),
  });
  assert.deepEqual(parseUser({ name: " Alice " }), { name: "Alice", email: undefined });
  assert.throws(() => parseUser({ name: "Alice", role: "admin" }), InputValidationError);
});
