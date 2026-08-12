export const PERMISSION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "stale",
] as const;

export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export const PERMISSION_DECISIONS = [
  "approved",
  "allow_once",
  "allow_always_tool",
  "allow_always_server",
  "rejected",
] as const;

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export interface DecidablePermission {
  status: PermissionStatus;
  expiresAt: number;
}

export type PermissionDecisionResult =
  | {
      ok: true;
      decision: PermissionDecision;
      status: "approved" | "rejected";
      decidedAt: number;
    }
  | {
      ok: false;
      reason: "invalid_decision" | "already_decided" | "expired";
      status: PermissionStatus;
    };

export function isPermissionStatus(value: unknown): value is PermissionStatus {
  return (
    typeof value === "string" &&
    (PERMISSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isPermissionDecision(value: unknown): value is PermissionDecision {
  return (
    typeof value === "string" &&
    (PERMISSION_DECISIONS as readonly string[]).includes(value)
  );
}

/**
 * Pure compare-and-set guard. Callers should persist the returned transition in
 * a transaction with `WHERE status = 'pending' AND expires_at > decidedAt`.
 */
export function evaluatePermissionDecision(
  permission: Readonly<DecidablePermission>,
  rawDecision: unknown,
  decidedAt = Date.now(),
): PermissionDecisionResult {
  if (!isPermissionDecision(rawDecision)) {
    return { ok: false, reason: "invalid_decision", status: permission.status };
  }
  if (permission.status !== "pending") {
    return { ok: false, reason: "already_decided", status: permission.status };
  }
  if (!Number.isFinite(permission.expiresAt) || permission.expiresAt <= decidedAt) {
    return { ok: false, reason: "expired", status: "expired" };
  }
  return {
    ok: true,
    decision: rawDecision,
    status: rawDecision === "rejected" ? "rejected" : "approved",
    decidedAt,
  };
}
