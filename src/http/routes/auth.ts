import type { IncomingMessage, ServerResponse } from "node:http";
import { hashPassword, verifyPassword } from "../../auth/passwords.js";
import { createSessionToken, digestSessionToken } from "../../auth/session-token.js";
import type { AppConfig } from "../../config.js";
import type { JsonObject, User } from "../../domain/index.js";
import type { PersistenceRepository } from "../../persistence/index.js";
import { HttpError, parseCookies, readJsonBody, requestIp, sendJson, sessionCookie } from "../core.js";
import { FixedWindowRateLimiter } from "../rate-limit.js";
import { inputString, objectBody } from "../validation.js";
import type { RouteAuth } from "./shared.js";

export interface AuthControllerOptions {
  repository: PersistenceRepository;
  config: AppConfig;
  now: () => number;
  audit: (userId: string | null, action: string, targetType: string, targetId: string, metadata: JsonObject) => void;
}

export class AuthController {
  private readonly limiter = new FixedWindowRateLimiter({ limit: 8, windowMs: 15 * 60_000 });

  constructor(private readonly options: AuthControllerOptions) {}

  authenticate(request: IncomingMessage): RouteAuth {
    const rawToken = parseCookies(request).cc_session;
    if (!rawToken) throw unauthorized();
    const tokenDigest = digestSessionToken(rawToken);
    let authSession = this.options.repository.getAuthSession(tokenDigest);
    if (!authSession) {
      const legacy = this.options.repository.getAuthSession(rawToken);
      if (legacy) {
        this.options.repository.deleteAuthSession(rawToken);
        authSession = { ...legacy, token: tokenDigest, lastSeenAt: this.options.now() };
        this.options.repository.saveAuthSession(authSession);
      }
    }
    if (!authSession) throw unauthorized();
    const user = this.options.repository.getUser(authSession.userId);
    if (!user || user.status !== "active") {
      this.options.repository.deleteAuthSession(tokenDigest);
      throw unauthorized();
    }
    if (this.options.now() - authSession.lastSeenAt > 60_000) {
      this.options.repository.saveAuthSession({ ...authSession, lastSeenAt: this.options.now() });
    }
    return { user, rawToken, tokenDigest, expiresAt: authSession.expiresAt };
  }

  async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = objectBody(await readJsonBody(request, this.options.config.maxBodySize));
    const username = inputString(body.username, "username", 1, 64).toLowerCase();
    const password = inputString(body.password, "password", 1, 512, false);
    const rate = this.limiter.consume(`${requestIp(request)}:${username}`);
    if (!rate.allowed) throw new HttpError(429, "LOGIN_RATE_LIMITED", "登录尝试过多，请稍后重试。");
    const user = this.options.repository.getUserByUsername(username);
    const verification = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, "invalid:invalid");
    if (!user || user.status !== "active" || !verification.valid) {
      this.options.audit(null, "auth.login_failed", "user", user?.id || username, { ip: requestIp(request) });
      throw new HttpError(401, "INVALID_CREDENTIALS", "用户名或密码不正确。");
    }
    if (verification.needsRehash) {
      this.options.repository.saveUser({ ...user, passwordHash: await hashPassword(password), updatedAt: this.options.now() });
    }
    const token = createSessionToken();
    const createdAt = this.options.now();
    this.options.repository.saveAuthSession({ token: token.digest, userId: user.id, expiresAt: createdAt + this.options.config.sessionTtlMs, createdAt, lastSeenAt: createdAt });
    this.options.audit(user.id, "auth.login", "user", user.id, { ip: requestIp(request) });
    sendJson(response, 200, { user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(token.token, { secure: this.options.config.cookieSecure, maximumAgeSeconds: Math.floor(this.options.config.sessionTtlMs / 1000) }),
    });
  }

  logout(response: ServerResponse, auth: RouteAuth): void {
    this.options.repository.deleteAuthSession(auth.tokenDigest);
    this.options.repository.deleteAuthSession(auth.rawToken);
    this.options.audit(auth.user.id, "auth.logout", "user", auth.user.id, {});
    sendJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", { secure: this.options.config.cookieSecure, maximumAgeSeconds: 0 }) });
  }

  async changePassword(request: IncomingMessage, response: ServerResponse, auth: RouteAuth): Promise<void> {
    const body = objectBody(await readJsonBody(request, this.options.config.maxBodySize));
    const currentPassword = inputString(body.currentPassword, "currentPassword", 1, 512, false);
    const newPassword = passwordInput(body.newPassword);
    const verified = await verifyPassword(currentPassword, auth.user.passwordHash);
    if (!verified.valid) throw new HttpError(403, "CURRENT_PASSWORD_INVALID", "当前密码不正确。");
    this.options.repository.saveUser({ ...auth.user, passwordHash: await hashPassword(newPassword), updatedAt: this.options.now() });
    this.options.repository.revokeAuthSessionsForUser(auth.user.id, auth.tokenDigest);
    this.options.audit(auth.user.id, "auth.password_changed", "user", auth.user.id, {});
    sendJson(response, 200, { ok: true });
  }
}

function passwordInput(value: unknown): string {
  const password = inputString(value, "password", 8, 512, false);
  if (/^\s+$/.test(password)) throw new HttpError(400, "INVALID_INPUT", "密码不能只包含空白字符。");
  return password;
}

function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

function unauthorized(): HttpError {
  return new HttpError(401, "UNAUTHENTICATED", "登录已失效，请重新登录。");
}
