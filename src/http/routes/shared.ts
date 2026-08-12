import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "../../domain/index.js";
import { HttpError } from "../core.js";

export interface RouteAuth {
  user: User;
  rawToken: string;
  tokenDigest: string;
  expiresAt: number;
}

export interface RouteRequest {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  auth: RouteAuth;
  match: RegExpMatchArray | null;
  requestId: string;
}

export interface RouteDefinition {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string | RegExp;
  handle(input: RouteRequest): void | Promise<void>;
}

export function findRoute(routes: readonly RouteDefinition[], method: string, pathname: string): { route: RouteDefinition; match: RegExpMatchArray | null } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === "string") {
      if (route.path === pathname) return { route, match: null };
      continue;
    }
    const match = pathname.match(route.path);
    if (match) return { route, match };
  }
  return null;
}

export function routeId(match: RegExpMatchArray | null, index: number): string {
  const value = match?.[index];
  if (!value) throw new HttpError(400, "INVALID_PATH", "路径参数缺失。");
  try { return decodeURIComponent(value); } catch { throw new HttpError(400, "INVALID_PATH", "路径参数编码不正确。"); }
}
