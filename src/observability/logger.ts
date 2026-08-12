import type { JsonObject, JsonValue } from "../domain/index.js";

const SENSITIVE_KEY = /(?:password|passwd|secret|token|cookie|authorization|credential|api[_-]?key|session[_-]?key)/i;

export interface StructuredLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export class JsonLogger implements StructuredLogger {
  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields);
  }

  private write(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...redactRecord(fields) });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

export function redactRecord(value: Record<string, unknown>, depth = 0): JsonObject {
  if (depth > 8) return { truncated: true };
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
  }
  return output;
}

function redactValue(value: unknown, depth: number): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") return redactRecord(value as Record<string, unknown>, depth);
  return String(value);
}
