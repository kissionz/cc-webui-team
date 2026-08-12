import { HttpError } from "./core.js";

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("请求体必须是 JSON 对象。");
  return value as Record<string, unknown>;
}

export function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw invalid(`不支持字段 ${unexpected}。`);
}

export function inputString(value: unknown, name: string, minimum: number, maximum: number, trim = true): string {
  if (typeof value !== "string") throw invalid(`${name} 必须是字符串。`);
  const parsed = trim ? value.trim() : value;
  if (parsed.length < minimum || parsed.length > maximum) throw invalid(`${name} 长度必须在 ${minimum} 到 ${maximum} 个字符之间。`);
  return parsed;
}

export function inputBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${name} 必须是布尔值。`);
  return value;
}

export function inputInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw invalid(`${name} 数值不正确。`);
  return value as number;
}

export function inputNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw invalid(`${name} 数值不正确。`);
  return value;
}

export function inputEnum<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw invalid(`${name} 的值不正确。`);
  return value as T;
}

export function inputStringList(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || item.length > 512)) {
    throw invalid(`${name} 必须是有效的字符串数组。`);
  }
  return [...new Set(value.map((item) => (item as string).trim()).filter(Boolean))];
}

export function queryInteger(url: URL, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = url.searchParams.get(name);
  return raw === null ? fallback : inputInteger(Number(raw), name, minimum, maximum);
}

export function optionalQuery(url: URL, name: string, maximum = 256): string | undefined {
  const raw = url.searchParams.get(name);
  return raw === null || raw === "" ? undefined : inputString(raw, name, 1, maximum);
}

export function invalid(message: string): HttpError {
  return new HttpError(400, "INVALID_INPUT", message);
}
