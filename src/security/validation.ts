export class InputValidationError extends Error {
  readonly code = "INVALID_INPUT";

  constructor(
    message: string,
    readonly path = "$",
  ) {
    super(`${path}: ${message}`);
    this.name = "InputValidationError";
  }
}

export type Parser<T> = (value: unknown, path?: string) => T;

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  trim?: boolean;
  pattern?: RegExp;
}

export function assertRecord(
  value: unknown,
  path = "$",
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("expected an object", path);
  }
}

export function string(options: StringOptions = {}): Parser<string> {
  return (value, path = "$") => {
    if (typeof value !== "string") {
      throw new InputValidationError("expected a string", path);
    }
    const parsed = options.trim ? value.trim() : value;
    if (options.minLength !== undefined && parsed.length < options.minLength) {
      throw new InputValidationError(
        `must contain at least ${options.minLength} characters`,
        path,
      );
    }
    if (options.maxLength !== undefined && parsed.length > options.maxLength) {
      throw new InputValidationError(
        `must contain at most ${options.maxLength} characters`,
        path,
      );
    }
    if (options.pattern) {
      options.pattern.lastIndex = 0;
      if (!options.pattern.test(parsed)) {
        throw new InputValidationError("has an invalid format", path);
      }
    }
    return parsed;
  };
}

export function boolean(): Parser<boolean> {
  return (value, path = "$") => {
    if (typeof value !== "boolean") {
      throw new InputValidationError("expected a boolean", path);
    }
    return value;
  };
}

export interface IntegerOptions {
  min?: number;
  max?: number;
}

export function integer(options: IntegerOptions = {}): Parser<number> {
  return (value, path = "$") => {
    if (!Number.isSafeInteger(value)) {
      throw new InputValidationError("expected a safe integer", path);
    }
    const parsed = value as number;
    if (options.min !== undefined && parsed < options.min) {
      throw new InputValidationError(`must be at least ${options.min}`, path);
    }
    if (options.max !== undefined && parsed > options.max) {
      throw new InputValidationError(`must be at most ${options.max}`, path);
    }
    return parsed;
  };
}

export function enumeration<const T extends readonly string[]>(values: T): Parser<T[number]> {
  return (value, path = "$") => {
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      throw new InputValidationError(`expected one of: ${values.join(", ")}`, path);
    }
    return value as T[number];
  };
}

export function optional<T>(parser: Parser<T>): Parser<T | undefined> {
  return (value, path = "$") => (value === undefined ? undefined : parser(value, path));
}

export function array<T>(parser: Parser<T>, maxLength?: number): Parser<T[]> {
  return (value, path = "$") => {
    if (!Array.isArray(value)) {
      throw new InputValidationError("expected an array", path);
    }
    if (maxLength !== undefined && value.length > maxLength) {
      throw new InputValidationError(`must have at most ${maxLength} items`, path);
    }
    return value.map((item, index) => parser(item, `${path}[${index}]`));
  };
}

export type Shape = Record<string, Parser<unknown>>;
export type InferShape<TShape extends Shape> = {
  [TKey in keyof TShape]: TShape[TKey] extends Parser<infer TValue> ? TValue : never;
};

export interface ObjectOptions {
  allowUnknown?: boolean;
}

export function object<TShape extends Shape>(
  shape: TShape,
  options: ObjectOptions = {},
): Parser<InferShape<TShape>> {
  return (value, path = "$") => {
    assertRecord(value, path);
    if (!options.allowUnknown) {
      const unknownKey = Object.keys(value).find((key) => !(key in shape));
      if (unknownKey) {
        throw new InputValidationError("unknown field", `${path}.${unknownKey}`);
      }
    }

    const parsed: Partial<InferShape<TShape>> = {};
    for (const key of Object.keys(shape) as Array<keyof TShape>) {
      const parser = shape[key];
      if (!parser) continue;
      parsed[key] = parser(value[String(key)], `${path}.${String(key)}`) as InferShape<TShape>[typeof key];
    }
    return parsed as InferShape<TShape>;
  };
}
