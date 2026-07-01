import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  GatewayError,
  type AccessCredentialRecord,
  type ApplyBillingEntitlementEventInput,
  type ApplyBillingEntitlementEventResult,
  type BillingEntitlementListResult,
  type BillingEventListResult,
  type BillingEventRecord,
  type BillingUsageReportInput,
  type BillingUsageReportResult,
  type BillingUsageReportRow,
  type Entitlement,
  type EntitlementState,
  type ListBillingEntitlementsInput,
  type ListBillingEventsInput,
  type PeriodKind,
  type Plan
} from "@codex-gateway/core";
import * as adminAudit from "./admin-audit.js";
import { entitlementColumns } from "./columns.js";
import { insertTransitionAudit } from "./entitlement-audit.js";
import * as entitlementQueries from "./entitlement-queries.js";
import {
  assertEntitlementTransition,
  entitlementTransitionAuditAction
} from "./entitlement-rules.js";
import * as plansStore from "./plans.js";
import * as requestEvents from "./request-events.js";
import { rowToEntitlement } from "./row-mappers.js";
import * as subjectsStore from "./subjects.js";

const billingEventColumns =
  "id, idempotency_key, payload_hash, provider, external_order_id, external_event_id, event_type, apply_mode, subject_id, plan_id, entitlement_id, status, amount_minor, currency, period_kind, period_start, period_end, applied_at, error_message, metadata_json, created_at";

export function apply(
  db: DatabaseSync,
  input: ApplyBillingEntitlementEventInput
): ApplyBillingEntitlementEventResult {
  const now = input.now ?? new Date();
  const existing = getByIdempotencyKey(db, input.idempotencyKey);
  if (existing) {
    assertPayloadMatches(existing, input.payloadHash);
    if (existing.status === "applied" || existing.status === "ignored") {
      return replayResult(db, existing);
    }
  }

  preflight(db, input, now);

  let finished = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = existing ?? insertInitialEvent(db, input, now);
    if (input.applyMode === "log_only") {
      updateEventIgnored(db, row.id);
      const updated = mustGetBillingEvent(db, row.id);
      const result = buildApplyResult(db, updated, false, null, []);
      db.exec("COMMIT");
      finished = true;
      return result;
    }

    db.exec("SAVEPOINT billing_apply");
    try {
      const applied = applyEntitlementChange(db, input, row.id, now);
      db.exec("RELEASE billing_apply");
      updateEventApplied(db, row.id, applied.entitlement, applied.plan, now);
      const updated = mustGetBillingEvent(db, row.id);
      const result = buildApplyResult(
        db,
        updated,
        false,
        applied.entitlement,
        applied.cancelledEntitlementIds
      );
      db.exec("COMMIT");
      finished = true;
      return result;
    } catch (err) {
      db.exec("ROLLBACK TO billing_apply");
      db.exec("RELEASE billing_apply");
      if (err instanceof GatewayError && err.httpStatus < 500) {
        throw err;
      }
      updateEventFailed(db, row.id, err);
      db.exec("COMMIT");
      finished = true;
      throw new GatewayError({
        code: "service_unavailable",
        message: "Billing entitlement event could not be applied.",
        httpStatus: 503
      });
    }
  } catch (err) {
    if (!finished) {
      db.exec("ROLLBACK");
    }
    throw err;
  }
}

export function getByIdempotencyKey(
  db: DatabaseSync,
  idempotencyKey: string
): BillingEventRecord | null {
  const row = db
    .prepare(
      `SELECT ${billingEventColumns}
       FROM billing_events
       WHERE idempotency_key = ?`
    )
    .get(idempotencyKey);
  return row ? rowToBillingEvent(row) : null;
}

export function list(
  db: DatabaseSync,
  input: ListBillingEventsInput = {}
): BillingEventListResult {
  const clauses: string[] = [];
  const params: string[] = [];
  if (input.subjectId) {
    clauses.push("subject_id = ?");
    params.push(input.subjectId);
  }
  if (input.provider) {
    clauses.push("provider = ?");
    params.push(input.provider);
  }
  if (input.externalOrderId) {
    clauses.push("external_order_id = ?");
    params.push(input.externalOrderId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${billingEventColumns}
       FROM billing_events
       ${where}
       ORDER BY created_at DESC, id DESC`
    )
    .all(...params)
    .map(rowToBillingEvent);
  const page = paginate(rows, input.limit, input.cursor);
  return {
    events: page.items,
    nextCursor: page.nextCursor
  };
}

export function listEntitlements(
  db: DatabaseSync,
  input: ListBillingEntitlementsInput
): BillingEntitlementListResult {
  assertSubjectExists(db, input.subjectId);
  const now = new Date();
  const current = activeEntitlement(db, input.subjectId, now);
  const all = entitlementQueries
    .list(db, { subjectId: input.subjectId })
    .filter((entitlement) => entitlement.id !== current?.id);
  const page = paginate(all, input.limit, input.cursor);
  return {
    subjectId: input.subjectId,
    current,
    history: page.items,
    nextCursor: page.nextCursor
  };
}

export function reportUsage(
  db: DatabaseSync,
  input: BillingUsageReportInput
): BillingUsageReportResult {
  assertSubjectExists(db, input.subjectId);
  const dailyRows = requestEvents.reportUsage(db, {
    subjectId: input.subjectId,
    since: input.from,
    until: input.to,
    groupBy: input.groupBy === "model" ? "model" : undefined,
    publicModelId: input.publicModelId,
    publicModelAliases: input.publicModelAliases
  });
  const grouped = new Map<string, BillingUsageReportRow>();
  for (const row of dailyRows) {
    const periodStart = usagePeriodStart(row.date, input.groupBy);
    const includeModel = input.groupBy === "model" || Boolean(input.publicModelId);
    const publicModelId = includeModel ? row.publicModelId ?? null : undefined;
    const key =
      input.groupBy === "model"
        ? `model:${publicModelId ?? ""}`
        : `${periodStart?.toISOString() ?? "none"}:${publicModelId ?? ""}`;
    const existing =
      grouped.get(key) ??
      {
        periodStart,
        ...(includeModel ? { publicModelId } : {}),
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedTokens: 0
      };
    existing.requestCount += row.requests;
    existing.successCount += row.ok;
    existing.errorCount += row.errors;
    existing.promptTokens += row.promptTokens;
    existing.completionTokens += row.completionTokens;
    existing.totalTokens += row.totalTokens;
    existing.estimatedTokens += row.estimatedTokens;
    grouped.set(key, existing);
  }
  const rows = Array.from(grouped.values()).sort((left, right) => {
    if (!left.periodStart || !right.periodStart) {
      return 0;
    }
    return left.periodStart.getTime() - right.periodStart.getTime();
  });
  const page = paginate(rows, input.limit, input.cursor, input.groupBy === "none" ? 1 : 90);
  return {
    subjectId: input.subjectId,
    from: input.from,
    to: input.to,
    groupBy: input.groupBy,
    rows: page.items,
    nextCursor: page.nextCursor
  };
}

function preflight(db: DatabaseSync, input: ApplyBillingEntitlementEventInput, now: Date): void {
  assertSubjectExists(db, input.subjectId);
  if (input.eventType === "notice" && input.applyMode !== "log_only") {
    throw new GatewayError({
      code: "invalid_request",
      message: "notice events require apply_mode=log_only.",
      httpStatus: 400
    });
  }
  if (input.applyMode === "log_only") {
    return;
  }

  if (input.eventType === "purchase" || input.eventType === "renew") {
    const plan = assertPlanActive(db, required(input.planId, "plan_id"));
    const period = normalizePeriod(input, now);
    assertActiveCredentialScopesAllowed(db, input.subjectId, plan.scopeAllowlist, now);
    const active = activeEntitlement(db, input.subjectId, now);
    const paused = latestEntitlementByState(db, input.subjectId, "paused");
    const scheduled = scheduledEntitlements(db, input.subjectId);

    if (input.eventType === "purchase") {
      if ((active || paused) && !input.replaceCurrent) {
        throw new GatewayError({
          code: "entitlement_already_active",
          message: "Subject already has an active or paused entitlement.",
          httpStatus: 409
        });
      }
      if (scheduled.length > 0 && !input.replaceScheduled) {
        throw invalidTransition("Subject already has a scheduled entitlement.");
      }
      return;
    }

    if (!active) {
      throw new GatewayError({
        code: "entitlement_not_found",
        message: "No active entitlement exists to renew.",
        httpStatus: 404
      });
    }
    if (!active.periodEnd) {
      throw invalidTransition("Unlimited entitlements cannot be renewed.");
    }
    if (!input.replaceCurrent && period.start.getTime() < active.periodEnd.getTime()) {
      throw invalidTransition("Renewal period overlaps the current entitlement.");
    }
    if (scheduled.length > 0 && !input.replaceScheduled) {
      throw invalidTransition("Subject already has a scheduled entitlement.");
    }
    return;
  }

  const target = resolveTransitionTarget(db, input, now);
  const nextState = transitionState(input.eventType);
  if (!nextState) {
    throw invalidTransition(`Unsupported billing event type: ${input.eventType}`);
  }
  try {
    assertEntitlementTransition(target, nextState, now);
  } catch (err) {
    throw invalidTransition(err instanceof Error ? err.message : String(err));
  }
}

function applyEntitlementChange(
  db: DatabaseSync,
  input: ApplyBillingEntitlementEventInput,
  billingEventId: string,
  now: Date
): { entitlement: Entitlement; plan: Plan | null; cancelledEntitlementIds: string[] } {
  if (input.eventType === "purchase" || input.eventType === "renew") {
    const plan = assertPlanActive(db, required(input.planId, "plan_id"));
    const period = normalizePeriod(input, now);
    const cancelledEntitlementIds: string[] = [];

    if (input.replaceCurrent) {
      cancelledEntitlementIds.push(
        ...cancelEntitlements(
          db,
          activeAndMaybePausedEntitlements(db, input.subjectId, Boolean(input.replacePaused)),
          now,
          "replaced",
          billingEventId,
          input
        )
      );
    }
    if (input.replaceScheduled) {
      cancelledEntitlementIds.push(
        ...cancelEntitlements(
          db,
          scheduledEntitlements(db, input.subjectId),
          now,
          "replaced",
          billingEventId,
          input
        )
      );
    }

    const entitlement = insertEntitlementFromPlan(db, plan, input, period, now);
    insertTransitionAudit(
      db,
      input.eventType === "renew" ? "entitlement-renew" : "entitlement-grant",
      entitlement,
      now,
      billingAuditParams(billingEventId, input)
    );
    return { entitlement, plan, cancelledEntitlementIds };
  }

  const target = resolveTransitionTarget(db, input, now);
  const nextState = transitionState(input.eventType);
  if (!nextState) {
    throw invalidTransition(`Unsupported billing event type: ${input.eventType}`);
  }
  const updated = updateEntitlementState(db, target, nextState, now, input.reason ?? null);
  insertTransitionAudit(
    db,
    entitlementTransitionAuditAction(target.state, nextState),
    target,
    now,
    {
      ...billingAuditParams(billingEventId, input),
      from_state: target.state,
      to_state: nextState,
      reason: input.reason ?? null
    }
  );
  return { entitlement: updated, plan: plansStore.get(db, updated.planId), cancelledEntitlementIds: [] };
}

function insertInitialEvent(
  db: DatabaseSync,
  input: ApplyBillingEntitlementEventInput,
  now: Date
): BillingEventRecord {
  const id = `bevt_${randomUUID().replaceAll("-", "")}`;
  db.prepare(
    `INSERT INTO billing_events (
      id, idempotency_key, payload_hash, provider, external_order_id, external_event_id,
      event_type, apply_mode, subject_id, plan_id, entitlement_id, status, amount_minor,
      currency, period_kind, period_start, period_end, applied_at, error_message,
      metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'failed', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
  ).run(
    id,
    input.idempotencyKey,
    input.payloadHash,
    input.provider,
    input.externalOrderId,
    input.externalEventId ?? null,
    input.eventType,
    input.applyMode,
    input.subjectId,
    input.planId ?? null,
    input.amountMinor ?? null,
    input.currency ?? null,
    input.periodKind ?? null,
    input.periodStart?.toISOString() ?? null,
    input.periodEnd?.toISOString() ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now.toISOString()
  );
  return mustGetBillingEvent(db, id);
}

function updateEventApplied(
  db: DatabaseSync,
  id: string,
  entitlement: Entitlement,
  plan: Plan | null,
  now: Date
): void {
  db.prepare(
    `UPDATE billing_events
     SET status = 'applied',
         entitlement_id = ?,
         plan_id = ?,
         period_kind = ?,
         period_start = ?,
         period_end = ?,
         applied_at = ?,
         error_message = NULL
     WHERE id = ?`
  ).run(
    entitlement.id,
    plan?.id ?? entitlement.planId,
    entitlement.periodKind,
    entitlement.periodStart.toISOString(),
    entitlement.periodEnd?.toISOString() ?? null,
    now.toISOString(),
    id
  );
}

function updateEventIgnored(db: DatabaseSync, id: string): void {
  db.prepare(
    `UPDATE billing_events
     SET status = 'ignored', entitlement_id = NULL, applied_at = NULL, error_message = NULL
     WHERE id = ?`
  ).run(id);
}

function updateEventFailed(db: DatabaseSync, id: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  db.prepare("UPDATE billing_events SET status = 'failed', error_message = ? WHERE id = ?").run(
    message.slice(0, 1000),
    id
  );
}

function updateEntitlementState(
  db: DatabaseSync,
  entitlement: Entitlement,
  nextState: EntitlementState,
  now: Date,
  reason: string | null
): Entitlement {
  try {
    assertEntitlementTransition(entitlement, nextState, now);
  } catch (err) {
    throw invalidTransition(err instanceof Error ? err.message : String(err));
  }
  if (nextState === "cancelled") {
    db.prepare(
      `UPDATE entitlements
       SET state = 'cancelled', cancelled_at = ?, cancelled_reason = ?
       WHERE id = ?`
    ).run(now.toISOString(), reason, entitlement.id);
  } else {
    db.prepare("UPDATE entitlements SET state = ? WHERE id = ?").run(nextState, entitlement.id);
  }
  const updated = entitlementQueries.get(db, entitlement.id);
  if (!updated) {
    throw new Error(`Entitlement not found after update: ${entitlement.id}`);
  }
  return updated;
}

function insertEntitlementFromPlan(
  db: DatabaseSync,
  plan: Plan,
  input: ApplyBillingEntitlementEventInput,
  period: { kind: PeriodKind; start: Date; end: Date | null },
  now: Date
): Entitlement {
  const entitlement: Entitlement = {
    id: `ent_${randomUUID().replaceAll("-", "")}`,
    subjectId: input.subjectId,
    planId: plan.id,
    policySnapshot: plan.policy,
    featurePolicySnapshot: plan.featurePolicy,
    scopeAllowlist: plan.scopeAllowlist,
    periodKind: period.kind,
    periodStart: period.start,
    periodEnd: period.end,
    state: period.start.getTime() > now.getTime() ? "scheduled" : "active",
    teamSeatId: null,
    createdAt: now,
    cancelledAt: null,
    cancelledReason: null,
    notes: input.reason ?? null
  };
  db.prepare(
    `INSERT INTO entitlements (
      id, subject_id, plan_id, policy_snapshot_json, feature_policy_snapshot_json, scope_allowlist_json,
      period_kind, period_start, period_end, state, team_seat_id, created_at,
      cancelled_at, cancelled_reason, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entitlement.id,
    entitlement.subjectId,
    entitlement.planId,
    JSON.stringify(entitlement.policySnapshot),
    JSON.stringify(entitlement.featurePolicySnapshot),
    JSON.stringify(entitlement.scopeAllowlist),
    entitlement.periodKind,
    entitlement.periodStart.toISOString(),
    entitlement.periodEnd?.toISOString() ?? null,
    entitlement.state,
    entitlement.teamSeatId,
    entitlement.createdAt.toISOString(),
    null,
    null,
    entitlement.notes
  );
  return entitlement;
}

function cancelEntitlements(
  db: DatabaseSync,
  entitlements: Entitlement[],
  now: Date,
  reason: string,
  billingEventId: string,
  input: ApplyBillingEntitlementEventInput
): string[] {
  const ids: string[] = [];
  for (const entitlement of entitlements) {
    const updated = updateEntitlementState(db, entitlement, "cancelled", now, reason);
    ids.push(updated.id);
    insertTransitionAudit(db, "entitlement-cancel", entitlement, now, {
      ...billingAuditParams(billingEventId, input),
      from_state: entitlement.state,
      to_state: "cancelled",
      reason
    });
  }
  return ids;
}

function billingAuditParams(
  billingEventId: string,
  input: ApplyBillingEntitlementEventInput
): Record<string, unknown> {
  return {
    source: "billing",
    billing_event_id: billingEventId,
    provider: input.provider,
    external_order_id: input.externalOrderId,
    external_event_id: input.externalEventId ?? null,
    event_type: input.eventType
  };
}

function replayResult(
  db: DatabaseSync,
  event: BillingEventRecord
): ApplyBillingEntitlementEventResult {
  const entitlement = event.entitlementId ? entitlementQueries.get(db, event.entitlementId) : null;
  return buildApplyResult(db, event, true, entitlement, cancelledIdsForBillingEvent(db, event.id));
}

function buildApplyResult(
  db: DatabaseSync,
  event: BillingEventRecord,
  idempotentReplay: boolean,
  entitlement: Entitlement | null,
  cancelledEntitlementIds: string[]
): ApplyBillingEntitlementEventResult {
  return {
    applied: event.status === "applied",
    idempotentReplay,
    billingEvent: event,
    subjectId: event.subjectId,
    plan: entitlement ? plansStore.get(db, entitlement.planId) : event.planId ? plansStore.get(db, event.planId) : null,
    entitlement,
    cancelledEntitlementIds
  };
}

function cancelledIdsForBillingEvent(db: DatabaseSync, billingEventId: string): string[] {
  return adminAudit
    .list(db, { action: "entitlement-cancel", limit: 200 })
    .filter((event) => event.params?.billing_event_id === billingEventId)
    .map((event) => event.params?.entitlement_id)
    .filter((id): id is string => typeof id === "string");
}

function assertPayloadMatches(event: BillingEventRecord, payloadHash: string): void {
  if (event.payloadHash !== payloadHash) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message: "Idempotency key was already used with a different payload.",
      httpStatus: 409
    });
  }
}

function assertSubjectExists(db: DatabaseSync, subjectId: string) {
  const subject = subjectsStore.get(db, subjectId);
  if (!subject || subject.state !== "active") {
    throw new GatewayError({
      code: "subject_not_found",
      message: "Subject does not exist or is not active.",
      httpStatus: 404
    });
  }
  return subject;
}

function assertPlanActive(db: DatabaseSync, planId: string): Plan {
  const plan = plansStore.get(db, planId);
  if (!plan) {
    throw new GatewayError({
      code: "plan_not_found",
      message: "Plan does not exist.",
      httpStatus: 404
    });
  }
  if (plan.state !== "active") {
    throw invalidTransition("Plan is not active.");
  }
  return plan;
}

function assertActiveCredentialScopesAllowed(
  db: DatabaseSync,
  subjectId: string,
  scopeAllowlist: string[],
  now: Date
): void {
  const rows = db
    .prepare(
      `SELECT prefix, scope
       FROM access_credentials
       WHERE subject_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?`
    )
    .all(subjectId, now.toISOString()) as Array<Pick<AccessCredentialRecord, "prefix" | "scope">>;
  const disallowed = rows.filter((row) => !scopeAllowlist.includes(row.scope));
  if (disallowed.length > 0) {
    throw invalidTransition(
      `Active credential scopes are not allowed by plan: ${disallowed
        .map((row) => row.prefix)
        .join(", ")}`
    );
  }
}

function normalizePeriod(
  input: ApplyBillingEntitlementEventInput,
  now: Date
): { kind: PeriodKind; start: Date; end: Date | null } {
  const kind = required(input.periodKind, "period_kind");
  const start = input.periodStart ?? now;
  const end = input.periodEnd ?? null;
  if (kind === "unlimited") {
    if (end) {
      throw invalidPeriod("unlimited entitlement period_end must be empty.");
    }
    return { kind, start, end: null };
  }
  if (!end) {
    throw invalidPeriod(`${kind} entitlement requires period_end.`);
  }
  if (end.getTime() <= start.getTime()) {
    throw invalidPeriod("period_end must be after period_start.");
  }
  return { kind, start, end };
}

function activeEntitlement(db: DatabaseSync, subjectId: string, now: Date): Entitlement | null {
  const row = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
         AND state = 'active'
         AND period_start <= ?
         AND (period_end IS NULL OR period_end > ?)
       ORDER BY period_start DESC, created_at DESC
       LIMIT 1`
    )
    .get(subjectId, now.toISOString(), now.toISOString());
  return row ? rowToEntitlement(row) : null;
}

function activeAndMaybePausedEntitlements(
  db: DatabaseSync,
  subjectId: string,
  includePaused: boolean
): Entitlement[] {
  const states = includePaused ? "('active', 'paused')" : "('active')";
  return db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
         AND state IN ${states}
       ORDER BY period_start DESC, created_at DESC`
    )
    .all(subjectId)
    .map(rowToEntitlement);
}

function scheduledEntitlements(db: DatabaseSync, subjectId: string): Entitlement[] {
  return db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
         AND state = 'scheduled'
       ORDER BY period_start ASC, created_at ASC`
    )
    .all(subjectId)
    .map(rowToEntitlement);
}

function latestEntitlementByState(
  db: DatabaseSync,
  subjectId: string,
  state: EntitlementState
): Entitlement | null {
  const row = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
         AND state = ?
       ORDER BY period_start DESC, created_at DESC
       LIMIT 1`
    )
    .get(subjectId, state);
  return row ? rowToEntitlement(row) : null;
}

function resolveTransitionTarget(
  db: DatabaseSync,
  input: ApplyBillingEntitlementEventInput,
  now: Date
): Entitlement {
  const target = input.entitlementId
    ? entitlementQueries.get(db, input.entitlementId)
    : input.eventType === "resume"
      ? latestEntitlementByState(db, input.subjectId, "paused")
      : activeEntitlement(db, input.subjectId, now);
  if (!target || target.subjectId !== input.subjectId) {
    throw new GatewayError({
      code: "entitlement_not_found",
      message: "Entitlement does not exist for this subject.",
      httpStatus: 404
    });
  }
  return target;
}

function transitionState(eventType: string): EntitlementState | null {
  if (eventType === "pause") {
    return "paused";
  }
  if (eventType === "resume") {
    return "active";
  }
  if (eventType === "cancel") {
    return "cancelled";
  }
  return null;
}

function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined || value === "") {
    throw new GatewayError({
      code: name === "period_kind" ? "invalid_period" : "invalid_request",
      message: `${name} is required.`,
      httpStatus: 400
    });
  }
  return value;
}

function invalidTransition(message: string): GatewayError {
  return new GatewayError({
    code: "invalid_entitlement_transition",
    message,
    httpStatus: 409
  });
}

function invalidPeriod(message: string): GatewayError {
  return new GatewayError({
    code: "invalid_period",
    message,
    httpStatus: 400
  });
}

function mustGetBillingEvent(db: DatabaseSync, id: string): BillingEventRecord {
  const row = db
    .prepare(
      `SELECT ${billingEventColumns}
       FROM billing_events
       WHERE id = ?`
    )
    .get(id);
  if (!row) {
    throw new Error(`Billing event not found after write: ${id}`);
  }
  return rowToBillingEvent(row);
}

function rowToBillingEvent(row: unknown): BillingEventRecord {
  const value = row as {
    id: string;
    idempotency_key: string;
    payload_hash: string;
    provider: string;
    external_order_id: string;
    external_event_id: string | null;
    event_type: BillingEventRecord["eventType"];
    apply_mode: BillingEventRecord["applyMode"];
    subject_id: string;
    plan_id: string | null;
    entitlement_id: string | null;
    status: BillingEventRecord["status"];
    amount_minor: number | null;
    currency: string | null;
    period_kind: PeriodKind | null;
    period_start: string | null;
    period_end: string | null;
    applied_at: string | null;
    error_message: string | null;
    metadata_json: string | null;
    created_at: string;
  };
  return {
    id: value.id,
    idempotencyKey: value.idempotency_key,
    payloadHash: value.payload_hash,
    provider: value.provider,
    externalOrderId: value.external_order_id,
    externalEventId: value.external_event_id,
    eventType: value.event_type,
    applyMode: value.apply_mode,
    subjectId: value.subject_id,
    planId: value.plan_id,
    entitlementId: value.entitlement_id,
    status: value.status,
    amountMinor: value.amount_minor,
    currency: value.currency,
    periodKind: value.period_kind,
    periodStart: value.period_start ? new Date(value.period_start) : null,
    periodEnd: value.period_end ? new Date(value.period_end) : null,
    appliedAt: value.applied_at ? new Date(value.applied_at) : null,
    errorMessage: value.error_message,
    metadata: value.metadata_json ? (JSON.parse(value.metadata_json) as Record<string, unknown>) : null,
    createdAt: new Date(value.created_at)
  };
}

function usagePeriodStart(date: string, groupBy: BillingUsageReportInput["groupBy"]): Date | null {
  if (groupBy === "none" || groupBy === "model") {
    return null;
  }
  if (groupBy === "month") {
    return new Date(`${date.slice(0, 7)}-01T00:00:00.000Z`);
  }
  return new Date(`${date}T00:00:00.000Z`);
}

function paginate<T>(
  rows: T[],
  requestedLimit: number | undefined,
  cursor: string | undefined,
  defaultLimit = 50
): { items: T[]; nextCursor: string | null } {
  const limit = normalizeLimit(requestedLimit, defaultLimit);
  const offset = decodeOffsetCursor(cursor);
  const items = rows.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor: nextOffset < rows.length ? encodeOffsetCursor(nextOffset) : null
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new GatewayError({
      code: "invalid_request",
      message: "limit must be a positive integer.",
      httpStatus: 400
    });
  }
  return Math.min(value, 200);
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    const offset = value.offset;
    if (typeof offset === "number" && Number.isInteger(offset) && offset >= 0) {
      return offset;
    }
  } catch {
    // Fall through to the public validation error.
  }
  throw new GatewayError({
    code: "invalid_request",
    message: "cursor is invalid.",
    httpStatus: 400
  });
}
