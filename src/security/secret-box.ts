import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const AAD = Buffer.from("claude-code-webui:maxcompute:v1", "utf8");

export interface SecretBoxOptions {
  environmentKey?: string;
  keyFile: string;
}

export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static async open(options: SecretBoxOptions): Promise<SecretBox> {
    const environmentKey = options.environmentKey?.trim();
    if (environmentKey) return new SecretBox(parseKey(environmentKey));
    await mkdir(dirname(options.keyFile), { recursive: true });
    try {
      return new SecretBox(parseKey((await readFile(options.keyFile, "utf8")).trim()));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const key = randomBytes(32);
    await writeFile(options.keyFile, key.toString("base64"), { mode: 0o600, flag: "wx" });
    return new SecretBox(key);
  }

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== 32) throw new Error("凭据加密密钥必须是 32 字节。");
    return new SecretBox(Buffer.from(key));
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt<T>(payload: string): T {
    const [version, ivText, tagText, ciphertextText] = payload.split(".");
    if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("凭据密文格式不正确。");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivText, "base64url"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }
}

function parseKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节随机值的 Base64 编码。");
  return key;
}
