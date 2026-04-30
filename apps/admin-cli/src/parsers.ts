import { InvalidArgumentError } from "commander";
import type {
  AdminAuditAction,
  AdminAuditStatus,
  EntitlementState,
  PeriodKind,
  PlanState,
  Scope,
  SubjectState,
  TokenLimitPolicy
} from "@codex-gateway/core";

type MissingUsageCharge = TokenLimitPolicy["missingUsageCharge"];

const adminAuditActions = new Set<AdminAuditAction>([
  "issue",
  "update-key",
  "revoke",
  "rotate",
  "reveal-key",
  "update-user",
  "disable-user",
  "enable-user",
  "prune-events",
  "token-overrun",
  "token-reservation-expired",
  "plan-create",
  "plan-deprecate",
  "entitlement-grant",
  "entitlement-renew",
  "entitlement-cancel",
  "entitlement-pause",
  "entitlement-resume",
  "entitlement-activate",
  "entitlement-expire"
]);

const adminAuditStatuses = new Set<AdminAuditStatus>(["ok", "error"]);
const entitlementStates = new Set<EntitlementState>([
  "scheduled",
  "active",
  "paused",
  "expired",
  "cancelled"
]);
const missingUsageCharges = new Set<MissingUsageCharge>(["none", "estimate", "reserve"]);
const periodKinds = new Set<PeriodKind>(["monthly", "one_off", "unlimited"]);
const planStates = new Set<PlanState>(["active", "deprecated"]);
const scopes = new Set<Scope>(["code", "medical"]);
const subjectStates = new Set<SubjectState>(["active", "disabled", "archived"]);

export function parseScopeList(value: string): Scope[] {
  const parsedScopes = parseCommaList(value).map(parseScope);
  if (parsedScopes.length === 0) {
    throw new InvalidArgumentError("scope list must not be empty");
  }
  return Array.from(new Set(parsedScopes));
}

export function parsePlanState(value: string): PlanState {
  return parseSetValue(value, planStates, "plan state must be active or deprecated");
}

export function parsePeriodKind(value: string): PeriodKind {
  return parseSetValue(value, periodKinds, "period must be monthly, one_off, or unlimited");
}

export function parseEntitlementState(value: string): EntitlementState {
  return parseSetValue(
    value,
    entitlementStates,
    "entitlement state must be scheduled, active, paused, expired, or cancelled"
  );
}

export function parseReportGroupBy(value: string): "entitlement" {
  if (value === "entitlement") {
    return value;
  }
  throw new InvalidArgumentError("group-by must be entitlement");
}

export function parseDurationMs(value: string): number {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new InvalidArgumentError("duration must look like 30m, 1h, or 7d");
  }
  const amountText = match[1];
  const unit = match[2];
  if (!amountText || !unit) {
    throw new InvalidArgumentError("duration must look like 30m, 1h, or 7d");
  }
  const amount = Number.parseInt(amountText, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new InvalidArgumentError("duration amount must be a positive integer");
  }
  if (unit === "m") {
    return amount * 60_000;
  }
  if (unit === "h") {
    return amount * 60 * 60_000;
  }
  return amount * 24 * 60 * 60_000;
}

export function parseScope(value: string): Scope {
  return parseSetValue(value, scopes, "scope must be code or medical");
}

export function parseSubjectState(value: string): SubjectState {
  return parseSetValue(value, subjectStates, "state must be active, disabled, or archived");
}

export function parseAdminAuditAction(value: string): AdminAuditAction {
  return parseSetValue(value, adminAuditActions, "action must be a known admin audit action");
}

export function parseAdminAuditStatus(value: string): AdminAuditStatus {
  return parseSetValue(value, adminAuditStatuses, "status must be ok or error");
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("value must be a non-negative integer");
  }
  return parsed;
}

export function parseNullablePositiveInteger(value: string): number | null {
  if (value.toLowerCase() === "null" || value.toLowerCase() === "none") {
    return null;
  }
  return parsePositiveInteger(value);
}

export function parseNullableNonNegativeInteger(value: string): number | null {
  if (value.toLowerCase() === "null" || value.toLowerCase() === "none") {
    return null;
  }
  return parseNonNegativeInteger(value);
}

export function parseMissingUsageCharge(value: string): MissingUsageCharge {
  return parseSetValue(
    value,
    missingUsageCharges,
    "missing usage charge must be none, estimate, or reserve"
  );
}

export function parseDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidArgumentError("value must be a valid ISO date or datetime");
  }
  return parsed;
}

export function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSetValue<T extends string>(
  value: string,
  allowed: ReadonlySet<T>,
  message: string
): T {
  if (allowed.has(value as T)) {
    return value as T;
  }
  throw new InvalidArgumentError(message);
}
