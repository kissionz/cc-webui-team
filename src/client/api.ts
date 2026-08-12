export interface ApiErrorShape { message?: string; code?: string; details?: unknown }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  let payload: ApiErrorShape & T = {} as ApiErrorShape & T;
  try { payload = text ? JSON.parse(text) as ApiErrorShape & T : payload; } catch {
    throw new ApiError("服务返回了无法识别的响应。", response.status);
  }
  if (!response.ok) throw new ApiError(payload.message || payload.code || "请求失败", response.status, payload.code, payload.details);
  return payload as T;
}

export function downloadApi(path: string): void {
  const link = document.createElement("a");
  link.href = path;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}
