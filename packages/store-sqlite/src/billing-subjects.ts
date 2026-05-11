import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  GatewayError,
  type AccessCredentialRecord,
  type BillingSubjectCredential,
  type BillingSubjectLifecycleEventType,
  type BillingSubjectDetails,
  type CreateBillingSubjectInput,
  type CreateBillingSubjectResult,
  type DisableBillingSubjectInput,
  type DisableBillingSubjectResult,
  type RotateBillingSubjectInput,
  type RotateBillingSubjectResult,
  type Scope,
  type Subject,
  type UnifiedClientKeyRecord,
  type UpstreamV2BindingRecord
} from "@codex-gateway/core";
import * as accessCredentials from "./access-credentials.js";
import * as adminAudit from "./admin-audit.js";
import {
  accessCredentialColumns,
  unifiedClientKeyColumns
} from "./columns.js";
import { rowToAccessCredential, rowToUnifiedClientKey } from "./row-mappers.js";
import { runInTransaction } from "./sql.js";
import * as subjectsStore from "./subjects.js";
import * as unifiedClientKeys from "./unified-client-keys.js";

const v2BindingColumns =
  "subject_id, v2_user_id, v2_key_id, state, last_synced_at, metadata_json, created_at, updated_at";

interface BillingSubjectEventRow {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  event_type: BillingSubjectLifecycleEventType;
  provider: string;
  external_user_id: string;
  subject_id: string;
  credential_id: string | null;
  credential_prefix: string | null;
  unified_key_id: string | null;
  unified_key_prefix: string | null;
  status: "applied" | "failed";
  error_message: string | null;
  metadata_json: string | null;
  applied_at: string | null;
  created_at: string;
}

export function create(
  db: DatabaseSync,
  input: CreateBillingSubjectInput
): CreateBillingSubjectResult {
  const existing = getEventByIdempotencyKey(db, input.idempotencyKey);
  if (existing) {
    assertPayloadMatches(existing, input.payloadHash);
    return replayCreateResult(db, existing);
  }

  assertNoExternalSubject(db, input.provider, input.externalUserId);

  const now = input.now ?? new Date();
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const eventAfterLock = getEventByIdempotencyKey(db, input.idempotencyKey);
    if (eventAfterLock) {
      assertPayloadMatches(eventAfterLock, input.payloadHash);
      return replayCreateResult(db, eventAfterLock);
    }
    assertNoExternalSubject(db, input.provider, input.externalUserId);

    const subject: Subject = {
      id: input.subjectId,
      label: input.displayName || input.externalUserId,
      name: null,
      phoneNumber: null,
      externalProvider: input.provider,
      externalUserId: input.externalUserId,
      displayName: input.displayName ?? null,
      state: "active",
      createdAt: now
    };

    subjectsStore.upsert(db, subject);
    accessCredentials.insert(db, input.gatewayCredential);
    unifiedClientKeys.insert(db, input.unifiedClientKey);
    insertV2Binding(db, input.upstreamV2Binding);
    const event = insertCreateEvent(db, input, now);
    insertCreateAudit(db, input, event.id, now);

    return {
      created: true,
      idempotentReplay: false,
      subject,
      scopeAllowlist: input.scopeAllowlist,
      credentials: credentialsForSubject(db, subject.id),
      upstreamV2Binding: input.upstreamV2Binding,
      gatewayCredential: input.gatewayCredential,
      unifiedClientKey: input.unifiedClientKey
    };
  });
}

export function replayCreate(
  db: DatabaseSync,
  idempotencyKey: string,
  payloadHash: string
): CreateBillingSubjectResult | null {
  const existing = getEventByIdempotencyKey(db, idempotencyKey);
  if (!existing) {
    return null;
  }
  assertPayloadMatches(existing, payloadHash);
  return replayCreateResult(db, existing);
}

export function replayRotate(
  db: DatabaseSync,
  idempotencyKey: string,
  payloadHash: string
): RotateBillingSubjectResult | null {
  const existing = getEventByIdempotencyKey(db, idempotencyKey);
  if (!existing) {
    return null;
  }
  assertEventType(existing, "rotate_key");
  assertPayloadMatches(existing, payloadHash);
  return replayRotateResult(db, existing);
}

export function rotate(
  db: DatabaseSync,
  input: RotateBillingSubjectInput
): RotateBillingSubjectResult {
  const existing = getEventByIdempotencyKey(db, input.idempotencyKey);
  if (existing) {
    assertEventType(existing, "rotate_key");
    assertPayloadMatches(existing, input.payloadHash);
    return replayRotateResult(db, existing);
  }

  const now = input.now ?? new Date();
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const eventAfterLock = getEventByIdempotencyKey(db, input.idempotencyKey);
    if (eventAfterLock) {
      assertEventType(eventAfterLock, "rotate_key");
      assertPayloadMatches(eventAfterLock, input.payloadHash);
      return replayRotateResult(db, eventAfterLock);
    }

    const subject = assertActiveSubject(db, input.subjectId);
    accessCredentials.insert(db, input.gatewayCredential);
    unifiedClientKeys.insert(db, input.unifiedClientKey);

    const revokedCredentialIds = input.revokePrevious
      ? supersedeAccessCredentials(db, input.subjectId, input.gatewayCredential.id, now, input.gracePeriodSeconds)
      : [];
    const revokedUnifiedKeyIds = input.revokePrevious
      ? supersedeUnifiedClientKeys(db, input.subjectId, input.unifiedClientKey.id, now, input.gracePeriodSeconds)
      : [];

    const event = insertSubjectLifecycleEvent(db, {
      input,
      eventType: "rotate_key",
      provider: subject.externalProvider ?? "unknown",
      externalUserId: subject.externalUserId ?? subject.id,
      subjectId: subject.id,
      credentialId: input.gatewayCredential.id,
      credentialPrefix: input.gatewayCredential.prefix,
      unifiedKeyId: input.unifiedClientKey.id,
      unifiedKeyPrefix: input.unifiedClientKey.prefix,
      metadata: {
        reason: input.reason ?? null,
        revoke_previous: input.revokePrevious,
        grace_period_seconds: input.gracePeriodSeconds,
        revoked_credential_ids: revokedCredentialIds,
        revoked_unified_key_ids: revokedUnifiedKeyIds
      },
      now
    });
    insertRotateAudit(db, input, event.id, revokedCredentialIds, revokedUnifiedKeyIds, now);

    return {
      rotated: true,
      idempotentReplay: false,
      subject,
      scopeAllowlist: scopeAllowlistForSubject(db, subject.id),
      credentials: credentialsForSubject(db, subject.id),
      upstreamV2Binding: getV2Binding(db, subject.id),
      gatewayCredential: input.gatewayCredential,
      unifiedClientKey: input.unifiedClientKey,
      revokedCredentialIds,
      revokedUnifiedKeyIds
    };
  });
}

export function replayDisable(
  db: DatabaseSync,
  idempotencyKey: string,
  payloadHash: string
): DisableBillingSubjectResult | null {
  const existing = getEventByIdempotencyKey(db, idempotencyKey);
  if (!existing) {
    return null;
  }
  assertEventType(existing, "disable_subject");
  assertPayloadMatches(existing, payloadHash);
  return replayDisableResult(db, existing);
}

export function disable(
  db: DatabaseSync,
  input: DisableBillingSubjectInput
): DisableBillingSubjectResult {
  const existing = getEventByIdempotencyKey(db, input.idempotencyKey);
  if (existing) {
    assertEventType(existing, "disable_subject");
    assertPayloadMatches(existing, input.payloadHash);
    return replayDisableResult(db, existing);
  }

  const now = input.now ?? new Date();
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const eventAfterLock = getEventByIdempotencyKey(db, input.idempotencyKey);
    if (eventAfterLock) {
      assertEventType(eventAfterLock, "disable_subject");
      assertPayloadMatches(eventAfterLock, input.payloadHash);
      return replayDisableResult(db, eventAfterLock);
    }

    const subject = assertSubjectExists(db, input.subjectId);
    const revokedCredentialIds = revokeActiveAccessCredentials(db, subject.id, now);
    const revokedUnifiedKeyIds = revokeActiveUnifiedClientKeys(db, subject.id, now);
    const cancelledEntitlementIds = cancelActiveEntitlements(db, subject.id, now, input.reason ?? "disabled");
    subjectsStore.setState(db, subject.id, "disabled");
    disableV2Binding(db, subject.id, now);

    const event = insertSubjectLifecycleEvent(db, {
      input,
      eventType: "disable_subject",
      provider: subject.externalProvider ?? "unknown",
      externalUserId: subject.externalUserId ?? subject.id,
      subjectId: subject.id,
      credentialId: null,
      credentialPrefix: null,
      unifiedKeyId: null,
      unifiedKeyPrefix: null,
      metadata: {
        reason: input.reason ?? null,
        revoked_credential_ids: revokedCredentialIds,
        revoked_unified_key_ids: revokedUnifiedKeyIds,
        cancelled_entitlement_ids: cancelledEntitlementIds
      },
      now
    });
    insertDisableAudit(db, subject.id, event.id, input.reason ?? null, revokedCredentialIds, revokedUnifiedKeyIds, cancelledEntitlementIds, now);

    const disabledSubject = subjectsStore.get(db, subject.id) ?? subject;
    return {
      disabled: true,
      idempotentReplay: false,
      subject: disabledSubject,
      scopeAllowlist: scopeAllowlistForSubject(db, subject.id),
      credentials: credentialsForSubject(db, subject.id),
      upstreamV2Binding: getV2Binding(db, subject.id),
      revokedCredentialIds,
      revokedUnifiedKeyIds,
      cancelledEntitlementIds
    };
  });
}

export function getDetails(db: DatabaseSync, subjectId: string): BillingSubjectDetails | null {
  const subject = subjectsStore.get(db, subjectId);
  if (!subject) {
    return null;
  }
  return detailsForSubject(db, subject);
}

export function getDetailsByExternal(
  db: DatabaseSync,
  provider: string,
  externalUserId: string
): BillingSubjectDetails | null {
  const subject = subjectsStore.getByExternal(db, provider, externalUserId);
  if (!subject) {
    return null;
  }
  return detailsForSubject(db, subject);
}

export function getActiveUnifiedKey(
  db: DatabaseSync,
  subjectId: string,
  now: Date = new Date()
): UnifiedClientKeyRecord | null {
  const row = db
    .prepare(
      `SELECT ${unifiedClientKeyColumns}
       FROM unified_client_keys
       WHERE subject_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(subjectId, now.toISOString());
  return row ? rowToUnifiedClientKey(row) : null;
}

function replayCreateResult(
  db: DatabaseSync,
  event: BillingSubjectEventRow
): CreateBillingSubjectResult {
  assertEventType(event, "create_subject");
  if (event.status !== "applied") {
    throw new GatewayError({
      code: "service_unavailable",
      message: "Billing subject event has not been applied.",
      httpStatus: 503
    });
  }
  const subject = subjectsStore.get(db, event.subject_id);
  if (!subject) {
    throw new GatewayError({
      code: "subject_not_found",
      message: "Billing subject event points to a missing subject.",
      httpStatus: 404
    });
  }
  const gatewayCredential = mustGetAccessCredentialById(db, requiredId(event.credential_id));
  const unifiedClientKey = mustGetUnifiedClientKeyById(db, requiredId(event.unified_key_id));
  return {
    created: false,
    idempotentReplay: true,
    subject,
    scopeAllowlist: scopeAllowlistForSubject(db, subject.id),
    credentials: credentialsForSubject(db, subject.id),
    upstreamV2Binding: getV2Binding(db, subject.id),
    gatewayCredential,
    unifiedClientKey
  };
}

function replayRotateResult(
  db: DatabaseSync,
  event: BillingSubjectEventRow
): RotateBillingSubjectResult {
  if (event.status !== "applied") {
    throw unappliedEventError();
  }
  const subject = mustGetSubjectForEvent(db, event);
  const gatewayCredential = mustGetAccessCredentialById(db, requiredId(event.credential_id));
  const unifiedClientKey = mustGetUnifiedClientKeyById(db, requiredId(event.unified_key_id));
  const metadata = parseEventMetadata(event);
  return {
    rotated: false,
    idempotentReplay: true,
    subject,
    scopeAllowlist: scopeAllowlistForSubject(db, subject.id),
    credentials: credentialsForSubject(db, subject.id),
    upstreamV2Binding: getV2Binding(db, subject.id),
    gatewayCredential,
    unifiedClientKey,
    revokedCredentialIds: stringArray(metadata.revoked_credential_ids),
    revokedUnifiedKeyIds: stringArray(metadata.revoked_unified_key_ids)
  };
}

function replayDisableResult(
  db: DatabaseSync,
  event: BillingSubjectEventRow
): DisableBillingSubjectResult {
  if (event.status !== "applied") {
    throw unappliedEventError();
  }
  const subject = mustGetSubjectForEvent(db, event);
  const metadata = parseEventMetadata(event);
  return {
    disabled: false,
    idempotentReplay: true,
    subject,
    scopeAllowlist: scopeAllowlistForSubject(db, subject.id),
    credentials: credentialsForSubject(db, subject.id),
    upstreamV2Binding: getV2Binding(db, subject.id),
    revokedCredentialIds: stringArray(metadata.revoked_credential_ids),
    revokedUnifiedKeyIds: stringArray(metadata.revoked_unified_key_ids),
    cancelledEntitlementIds: stringArray(metadata.cancelled_entitlement_ids)
  };
}

function unappliedEventError(): GatewayError {
  return new GatewayError({
    code: "service_unavailable",
    message: "Billing subject event has not been applied.",
    httpStatus: 503
  });
}

function mustGetSubjectForEvent(db: DatabaseSync, event: BillingSubjectEventRow): Subject {
  const subject = subjectsStore.get(db, event.subject_id);
  if (!subject) {
    throw new GatewayError({
      code: "subject_not_found",
      message: "Billing subject event points to a missing subject.",
      httpStatus: 404
    });
  }
  return subject;
}

function detailsForSubject(db: DatabaseSync, subject: Subject): BillingSubjectDetails {
  return {
    subject,
    scopeAllowlist: scopeAllowlistForSubject(db, subject.id),
    credentials: credentialsForSubject(db, subject.id),
    upstreamV2Binding: getV2Binding(db, subject.id)
  };
}

function assertNoExternalSubject(db: DatabaseSync, provider: string, externalUserId: string): void {
  const existing = subjectsStore.getByExternal(db, provider, externalUserId);
  if (existing) {
    throw new GatewayError({
      code: "subject_already_exists",
      message: "Subject already exists for provider and external_user_id.",
      httpStatus: 409
    });
  }
}

function getEventByIdempotencyKey(
  db: DatabaseSync,
  idempotencyKey: string
): BillingSubjectEventRow | null {
  const row = db
    .prepare(
      `SELECT *
       FROM billing_subject_events
       WHERE idempotency_key = ?`
    )
    .get(idempotencyKey) as BillingSubjectEventRow | undefined;
  return row ?? null;
}

function insertCreateEvent(
  db: DatabaseSync,
  input: CreateBillingSubjectInput,
  now: Date
): BillingSubjectEventRow {
  const id = `bsev_${randomUUID().replaceAll("-", "")}`;
  db.prepare(
    `INSERT INTO billing_subject_events (
      id, idempotency_key, payload_hash, event_type, provider, external_user_id,
      subject_id, credential_id, credential_prefix, unified_key_id, unified_key_prefix,
      status, error_message, metadata_json, applied_at, created_at
    ) VALUES (?, ?, ?, 'create_subject', ?, ?, ?, ?, ?, ?, ?, 'applied', NULL, ?, ?, ?)`
  ).run(
    id,
    input.idempotencyKey,
    input.payloadHash,
    input.provider,
    input.externalUserId,
    input.subjectId,
    input.gatewayCredential.id,
    input.gatewayCredential.prefix,
    input.unifiedClientKey.id,
    input.unifiedClientKey.prefix,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now.toISOString(),
    now.toISOString()
  );
  const row = getEventByIdempotencyKey(db, input.idempotencyKey);
  if (!row) {
    throw new Error(`Billing subject event was not inserted: ${id}`);
  }
  return row;
}

function insertSubjectLifecycleEvent(
  db: DatabaseSync,
  input: {
    input:
      | RotateBillingSubjectInput
      | DisableBillingSubjectInput;
    eventType: BillingSubjectLifecycleEventType;
    provider: string;
    externalUserId: string;
    subjectId: string;
    credentialId: string | null;
    credentialPrefix: string | null;
    unifiedKeyId: string | null;
    unifiedKeyPrefix: string | null;
    metadata: Record<string, unknown>;
    now: Date;
  }
): BillingSubjectEventRow {
  const id = `bsev_${randomUUID().replaceAll("-", "")}`;
  db.prepare(
    `INSERT INTO billing_subject_events (
      id, idempotency_key, payload_hash, event_type, provider, external_user_id,
      subject_id, credential_id, credential_prefix, unified_key_id, unified_key_prefix,
      status, error_message, metadata_json, applied_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', NULL, ?, ?, ?)`
  ).run(
    id,
    input.input.idempotencyKey,
    input.input.payloadHash,
    input.eventType,
    input.provider,
    input.externalUserId,
    input.subjectId,
    input.credentialId,
    input.credentialPrefix,
    input.unifiedKeyId,
    input.unifiedKeyPrefix,
    JSON.stringify(input.metadata),
    input.now.toISOString(),
    input.now.toISOString()
  );
  const row = getEventByIdempotencyKey(db, input.input.idempotencyKey);
  if (!row) {
    throw new Error(`Billing subject event was not inserted: ${id}`);
  }
  return row;
}

function insertV2Binding(db: DatabaseSync, record: UpstreamV2BindingRecord): void {
  db.prepare(
    `INSERT INTO upstream_v2_bindings (
      subject_id, v2_user_id, v2_key_id, state, last_synced_at, metadata_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.subjectId,
    record.v2UserId,
    record.v2KeyId,
    record.state,
    record.lastSyncedAt?.toISOString() ?? null,
    record.metadata ? JSON.stringify(record.metadata) : null,
    record.createdAt.toISOString(),
    record.updatedAt.toISOString()
  );
}

function disableV2Binding(db: DatabaseSync, subjectId: string, now: Date): void {
  db.prepare(
    `UPDATE upstream_v2_bindings
     SET state = 'disabled',
         last_synced_at = ?,
         updated_at = ?
     WHERE subject_id = ?`
  ).run(now.toISOString(), now.toISOString(), subjectId);
}

function getV2Binding(db: DatabaseSync, subjectId: string): UpstreamV2BindingRecord | null {
  const row = db
    .prepare(
      `SELECT ${v2BindingColumns}
       FROM upstream_v2_bindings
       WHERE subject_id = ?`
    )
    .get(subjectId);
  return row ? rowToV2Binding(row) : null;
}

function rowToV2Binding(row: unknown): UpstreamV2BindingRecord {
  const value = row as {
    subject_id: string;
    v2_user_id: string;
    v2_key_id: string | null;
    state: UpstreamV2BindingRecord["state"];
    last_synced_at: string | null;
    metadata_json: string | null;
    created_at: string;
    updated_at: string;
  };
  return {
    subjectId: value.subject_id,
    v2UserId: value.v2_user_id,
    v2KeyId: value.v2_key_id,
    state: value.state,
    lastSyncedAt: value.last_synced_at ? new Date(value.last_synced_at) : null,
    metadata: value.metadata_json ? (JSON.parse(value.metadata_json) as Record<string, unknown>) : null,
    createdAt: new Date(value.created_at),
    updatedAt: new Date(value.updated_at)
  };
}

function credentialsForSubject(db: DatabaseSync, subjectId: string): BillingSubjectCredential[] {
  const now = new Date();
  const rows = db
    .prepare(
      `SELECT id, prefix, expires_at, revoked_at, created_at
       FROM unified_client_keys
       WHERE subject_id = ?
       ORDER BY created_at DESC`
    )
    .all(subjectId) as Array<{
    id: string;
    prefix: string;
    expires_at: string;
    revoked_at: string | null;
    created_at: string;
  }>;

  return rows.map((row) => {
    const expiresAt = new Date(row.expires_at);
    return {
      id: row.id,
      keyPrefix: `cgu_live_${row.prefix}`,
      issuedAt: new Date(row.created_at),
      expiresAt,
      state: row.revoked_at
        ? "revoked"
        : expiresAt.getTime() <= now.getTime()
          ? "expired"
          : "active"
    };
  });
}

function assertSubjectExists(db: DatabaseSync, subjectId: string): Subject {
  const subject = subjectsStore.get(db, subjectId);
  if (!subject) {
    throw new GatewayError({
      code: "subject_not_found",
      message: "Subject does not exist.",
      httpStatus: 404
    });
  }
  return subject;
}

function assertActiveSubject(db: DatabaseSync, subjectId: string): Subject {
  const subject = assertSubjectExists(db, subjectId);
  if (subject.state !== "active") {
    throw new GatewayError({
      code: "subject_not_found",
      message: "Subject does not exist or is not active.",
      httpStatus: 404
    });
  }
  return subject;
}

function supersedeAccessCredentials(
  db: DatabaseSync,
  subjectId: string,
  exceptCredentialId: string,
  now: Date,
  gracePeriodSeconds: number
): string[] {
  const rows = db
    .prepare(
      `SELECT id
       FROM access_credentials
       WHERE subject_id = ?
         AND id != ?
         AND revoked_at IS NULL
         AND expires_at > ?`
    )
    .all(subjectId, exceptCredentialId, now.toISOString()) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) {
    return ids;
  }
  if (gracePeriodSeconds > 0) {
    const graceUntil = new Date(now.getTime() + gracePeriodSeconds * 1000).toISOString();
    db.prepare(
      `UPDATE access_credentials
       SET expires_at = CASE WHEN expires_at > ? THEN ? ELSE expires_at END
       WHERE subject_id = ?
         AND id != ?
         AND revoked_at IS NULL
         AND expires_at > ?`
    ).run(graceUntil, graceUntil, subjectId, exceptCredentialId, now.toISOString());
    return ids;
  }
  db.prepare(
    `UPDATE access_credentials
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE subject_id = ?
       AND id != ?
       AND revoked_at IS NULL`
  ).run(now.toISOString(), subjectId, exceptCredentialId);
  return ids;
}

function supersedeUnifiedClientKeys(
  db: DatabaseSync,
  subjectId: string,
  exceptUnifiedKeyId: string,
  now: Date,
  gracePeriodSeconds: number
): string[] {
  const rows = db
    .prepare(
      `SELECT id
       FROM unified_client_keys
       WHERE subject_id = ?
         AND id != ?
         AND revoked_at IS NULL
         AND expires_at > ?`
    )
    .all(subjectId, exceptUnifiedKeyId, now.toISOString()) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) {
    return ids;
  }
  if (gracePeriodSeconds > 0) {
    const graceUntil = new Date(now.getTime() + gracePeriodSeconds * 1000).toISOString();
    db.prepare(
      `UPDATE unified_client_keys
       SET expires_at = CASE WHEN expires_at > ? THEN ? ELSE expires_at END
       WHERE subject_id = ?
         AND id != ?
         AND revoked_at IS NULL
         AND expires_at > ?`
    ).run(graceUntil, graceUntil, subjectId, exceptUnifiedKeyId, now.toISOString());
    return ids;
  }
  db.prepare(
    `UPDATE unified_client_keys
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE subject_id = ?
       AND id != ?
       AND revoked_at IS NULL`
  ).run(now.toISOString(), subjectId, exceptUnifiedKeyId);
  return ids;
}

function revokeActiveAccessCredentials(db: DatabaseSync, subjectId: string, now: Date): string[] {
  const rows = db
    .prepare(
      `SELECT id
       FROM access_credentials
       WHERE subject_id = ?
         AND revoked_at IS NULL`
    )
    .all(subjectId) as Array<{ id: string }>;
  db.prepare(
    `UPDATE access_credentials
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE subject_id = ?
       AND revoked_at IS NULL`
  ).run(now.toISOString(), subjectId);
  return rows.map((row) => row.id);
}

function revokeActiveUnifiedClientKeys(db: DatabaseSync, subjectId: string, now: Date): string[] {
  const rows = db
    .prepare(
      `SELECT id
       FROM unified_client_keys
       WHERE subject_id = ?
         AND revoked_at IS NULL`
    )
    .all(subjectId) as Array<{ id: string }>;
  db.prepare(
    `UPDATE unified_client_keys
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE subject_id = ?
       AND revoked_at IS NULL`
  ).run(now.toISOString(), subjectId);
  return rows.map((row) => row.id);
}

function cancelActiveEntitlements(
  db: DatabaseSync,
  subjectId: string,
  now: Date,
  reason: string
): string[] {
  const rows = db
    .prepare(
      `SELECT id
       FROM entitlements
       WHERE subject_id = ?
         AND state IN ('active', 'paused', 'scheduled')`
    )
    .all(subjectId) as Array<{ id: string }>;
  db.prepare(
    `UPDATE entitlements
     SET state = 'cancelled',
         cancelled_at = COALESCE(cancelled_at, ?),
         cancelled_reason = COALESCE(cancelled_reason, ?)
     WHERE subject_id = ?
       AND state IN ('active', 'paused', 'scheduled')`
  ).run(now.toISOString(), reason, subjectId);
  return rows.map((row) => row.id);
}

function scopeAllowlistForSubject(db: DatabaseSync, subjectId: string): Scope[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT scope
       FROM access_credentials
       WHERE subject_id = ?
       ORDER BY scope`
    )
    .all(subjectId) as Array<{ scope: Scope }>;
  return rows.map((row) => row.scope);
}

function mustGetAccessCredentialById(db: DatabaseSync, id: string): AccessCredentialRecord {
  const row = db
    .prepare(
      `SELECT ${accessCredentialColumns}
       FROM access_credentials
       WHERE id = ?`
    )
    .get(id);
  if (!row) {
    throw new GatewayError({
      code: "credential_not_found",
      message: "Gateway credential for subject event was not found.",
      httpStatus: 404
    });
  }
  return rowToAccessCredential(row);
}

function mustGetUnifiedClientKeyById(db: DatabaseSync, id: string): UnifiedClientKeyRecord {
  const row = db
    .prepare(
      `SELECT ${unifiedClientKeyColumns}
       FROM unified_client_keys
       WHERE id = ?`
    )
    .get(id);
  if (!row) {
    throw new GatewayError({
      code: "credential_not_found",
      message: "Unified client key for subject event was not found.",
      httpStatus: 404
    });
  }
  return rowToUnifiedClientKey(row);
}

function insertCreateAudit(
  db: DatabaseSync,
  input: CreateBillingSubjectInput,
  billingSubjectEventId: string,
  now: Date
): void {
  adminAudit.insert(db, {
    id: `audit_${randomUUID().replaceAll("-", "")}`,
    action: "provision-user",
    targetUserId: input.subjectId,
    targetCredentialId: null,
    targetCredentialPrefix: null,
    status: "ok",
    params: {
      source: "billing",
      billing_subject_event_id: billingSubjectEventId,
      provider: input.provider,
      external_user_id: input.externalUserId,
      scope_allowlist: input.scopeAllowlist
    },
    errorMessage: null,
    createdAt: now
  });
  adminAudit.insert(db, {
    id: `audit_${randomUUID().replaceAll("-", "")}`,
    action: "unified-key-issue",
    targetUserId: input.subjectId,
    targetCredentialId: input.unifiedClientKey.id,
    targetCredentialPrefix: input.unifiedClientKey.prefix,
    status: "ok",
    params: {
      source: "billing",
      billing_subject_event_id: billingSubjectEventId,
      provider: input.provider,
      external_user_id: input.externalUserId,
      codex_credential_prefix: input.gatewayCredential.prefix,
      medevidence_key_prefix: input.unifiedClientKey.medevidenceKeyPrefix
    },
    errorMessage: null,
    createdAt: now
  });
}

function insertRotateAudit(
  db: DatabaseSync,
  input: RotateBillingSubjectInput,
  billingSubjectEventId: string,
  revokedCredentialIds: string[],
  revokedUnifiedKeyIds: string[],
  now: Date
): void {
  adminAudit.insert(db, {
    id: `audit_${randomUUID().replaceAll("-", "")}`,
    action: "rotate",
    targetUserId: input.subjectId,
    targetCredentialId: input.gatewayCredential.id,
    targetCredentialPrefix: input.gatewayCredential.prefix,
    status: "ok",
    params: {
      source: "billing",
      billing_subject_event_id: billingSubjectEventId,
      reason: input.reason ?? null,
      revoke_previous: input.revokePrevious,
      grace_period_seconds: input.gracePeriodSeconds,
      revoked_credential_ids: revokedCredentialIds
    },
    errorMessage: null,
    createdAt: now
  });
  adminAudit.insert(db, {
    id: `audit_${randomUUID().replaceAll("-", "")}`,
    action: "unified-key-issue",
    targetUserId: input.subjectId,
    targetCredentialId: input.unifiedClientKey.id,
    targetCredentialPrefix: input.unifiedClientKey.prefix,
    status: "ok",
    params: {
      source: "billing",
      billing_subject_event_id: billingSubjectEventId,
      reason: input.reason ?? null,
      codex_credential_prefix: input.gatewayCredential.prefix,
      medevidence_key_prefix: input.unifiedClientKey.medevidenceKeyPrefix,
      revoked_unified_key_ids: revokedUnifiedKeyIds
    },
    errorMessage: null,
    createdAt: now
  });
}

function insertDisableAudit(
  db: DatabaseSync,
  subjectId: string,
  billingSubjectEventId: string,
  reason: string | null,
  revokedCredentialIds: string[],
  revokedUnifiedKeyIds: string[],
  cancelledEntitlementIds: string[],
  now: Date
): void {
  adminAudit.insert(db, {
    id: `audit_${randomUUID().replaceAll("-", "")}`,
    action: "disable-user",
    targetUserId: subjectId,
    targetCredentialId: null,
    targetCredentialPrefix: null,
    status: "ok",
    params: {
      source: "billing",
      billing_subject_event_id: billingSubjectEventId,
      reason,
      revoked_credential_ids: revokedCredentialIds,
      revoked_unified_key_ids: revokedUnifiedKeyIds,
      cancelled_entitlement_ids: cancelledEntitlementIds
    },
    errorMessage: null,
    createdAt: now
  });
}

function assertPayloadMatches(event: BillingSubjectEventRow, payloadHash: string): void {
  if (event.payload_hash !== payloadHash) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message: "Idempotency key was already used with a different payload.",
      httpStatus: 409
    });
  }
}

function assertEventType(
  event: BillingSubjectEventRow,
  eventType: BillingSubjectLifecycleEventType
): void {
  if (event.event_type !== eventType) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message: "Idempotency key was already used with a different subject event type.",
      httpStatus: 409
    });
  }
}

function parseEventMetadata(event: BillingSubjectEventRow): Record<string, unknown> {
  return event.metadata_json ? (JSON.parse(event.metadata_json) as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requiredId(id: string | null): string {
  if (!id) {
    throw new GatewayError({
      code: "credential_not_found",
      message: "Billing subject event is missing credential metadata.",
      httpStatus: 404
    });
  }
  return id;
}
