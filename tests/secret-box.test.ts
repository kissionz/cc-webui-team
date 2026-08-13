import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SecretBox } from "../src/security/secret-box.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("SecretBox", () => {
  it("encrypts credentials with authenticated encryption and never embeds plaintext", () => {
    const box = SecretBox.fromKey(Buffer.alloc(32, 4));
    const encrypted = box.encrypt({ accessKeyId: "LTAI-test-id", accessKeySecret: "highly-secret" });
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("LTAI-test-id");
    expect(encrypted).not.toContain("highly-secret");
    expect(box.decrypt(encrypted)).toEqual({ accessKeyId: "LTAI-test-id", accessKeySecret: "highly-secret" });
  });

  it("creates a reusable 0600 key file when no environment key is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-secret-box-"));
    roots.push(root);
    const keyFile = join(root, "credential.key");
    const first = await SecretBox.open({ keyFile });
    const encrypted = first.encrypt({ value: "secret" });
    const second = await SecretBox.open({ keyFile });
    expect(second.decrypt(encrypted)).toEqual({ value: "secret" });
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(Buffer.from((await readFile(keyFile, "utf8")).trim(), "base64")).toHaveLength(32);
  });
});
