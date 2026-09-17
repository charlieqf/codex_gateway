import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  GatewayError,
  normalizeMainlandChinaPhone,
  type ClaimExternalSubjectInput,
  type ExternalSubjectRegistration,
  type ExternalSubjectResolution,
  type RecordExternalSubjectCreateFailureInput,
  type RecordExternalSubjectUpstreamInput,
  type ExternalSubjectCompensationInput,
  type ResolveExternalSubjectInput,
  type ResolveExternalSubjectOptions,
  type Subject
} from "@codex-gateway/core";
import * as subjects from "./subjects.js";
import * as phoneAuth from "./phone-auth.js";
import * as adminAudit from "./admin-audit.js";
import { runInTransaction } from "./sql.js";

interface Registration {
  provider: string;
  external_user_id: string;
  phone_number: string;
  state: "ready" | "creating" | "linked";
  subject_id: string | null;
  idempotency_key: string | null;
  payload_hash: string | null;
  upstream_user_id: string | null;
  upstream_key_id: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  compensation_state: "none" | "pending" | "disabled";
  released_at: string | null;
}

export function registration(db: DatabaseSync, provider: string, externalUserId: string): Registration | null {
  return db.prepare(`SELECT provider, external_user_id, phone_number, state,
      subject_id, idempotency_key, payload_hash, upstream_user_id, upstream_key_id,
      last_error_code, last_error_at, compensation_state, released_at FROM external_subject_registrations
    WHERE provider = ? AND external_user_id = ?`).get(provider, externalUserId) as Registration | undefined ?? null;
}

export function publicRegistration(
  db: DatabaseSync,
  provider: string,
  externalUserId: string
): ExternalSubjectRegistration | null {
  const row = registration(db, provider, externalUserId);
  return row ? {
    provider: row.provider,
    externalUserId: row.external_user_id,
    phone: row.phone_number,
    state: row.state,
    subjectId: row.subject_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    upstreamUserId: row.upstream_user_id,
    upstreamKeyId: row.upstream_key_id,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at ? new Date(row.last_error_at) : null,
    compensationState: row.compensation_state,
    releasedAt: row.released_at ? new Date(row.released_at) : null
  } : null;
}

export function resolve(db: DatabaseSync, input: ResolveExternalSubjectInput, options: ResolveExternalSubjectOptions = {}): ExternalSubjectResolution {
  const phone = normalizeMainlandChinaPhone(input.phone);
  if (!phone) {
    throw new GatewayError({ code: "invalid_request", message: "A supported phone number is required.", httpStatus: 400 });
  }
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const prior = registration(db, input.provider, input.externalUserId);
    if (prior?.released_at) throw released();
    // Stable external identity wins after binding, including after a phone change.
    const existing = subjects.getByExternal(db, input.provider, input.externalUserId);
    if (options.createOnly) {
      const owners = subjects.list(db, {includeArchived: true}).filter(subject =>
        normalizeMainlandChinaPhone(subject.phoneNumber ?? "") === phone);
      const phoneOwner = options.phoneHash ? db.prepare("SELECT subject_id FROM phone_auth_identities WHERE phone_hash = ?")
        .get(options.phoneHash) as {subject_id: string} | undefined : undefined;
      const ids = new Set([...owners.map(subject => subject.id), ...(existing ? [existing.id] : []), ...(phoneOwner ? [phoneOwner.subject_id] : [])]);
      if (ids.size) throw new GatewayError({code: ids.size === 1 ? "subject_already_exists" : "identity_conflict",
        message: ids.size === 1 ? `手机号或外部身份已归属 Subject ${[...ids][0]}；人工开户不会关联、轮换或修改该账号。`
          : "手机号与外部身份存在多个账号归属，请人工核对；未修改任何账号。", httpStatus: 409});
    }
    if (existing) {
      if (existing.state !== "active") throw disabled();
      return { status: "linked", subject: enrollLinkedSubject(db, existing, phone, input, options) };
    }
    if (prior) {
      if (prior.phone_number !== phone) throw conflict();
      if (prior.state === "creating") return { status: "account_pending", subject: null };
    }
    const candidates = subjects.list(db, { includeArchived: true }).filter(
      subject => normalizeMainlandChinaPhone(subject.phoneNumber ?? "") === phone
    );
    if (candidates.length > 1) throw conflict();
    const subject = candidates[0] ?? null;
    if (subject && subject.state !== "active") throw disabled();
    if (subject) {
      const another = db.prepare(`SELECT 1 FROM external_subject_registrations
        WHERE provider = ? AND subject_id = ? AND external_user_id != ?`).get(
          input.provider, subject.id, input.externalUserId
        );
      if (another || (subject.externalProvider === input.provider && subject.externalUserId !== input.externalUserId)) {
        throw conflict();
      }
    }
    // A different external identity must not reserve/create the same phone concurrently.
    const owner = db.prepare(`SELECT 1 FROM external_subject_registrations
      WHERE phone_number = ? AND (provider != ? OR external_user_id != ?)
        AND state != 'linked' AND released_at IS NULL`).get(phone, input.provider, input.externalUserId);
    if (owner) throw conflict();
    const timestamp = (input.now ?? new Date()).toISOString();
    db.prepare(`INSERT INTO external_subject_registrations
      (provider, external_user_id, phone_number, state, subject_id, request_id, created_at, updated_at, release_eligible)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(provider, external_user_id) DO UPDATE SET
        state = excluded.state, subject_id = excluded.subject_id,
        request_id = excluded.request_id, updated_at = excluded.updated_at`).run(
          input.provider, input.externalUserId, phone, subject ? "linked" : "ready",
          subject?.id ?? null, input.requestId, timestamp, timestamp
        );
    return { status: subject ? "linked" : "create_ready",
      subject: subject ? enrollLinkedSubject(db, subject, phone, input, options) : null };
  });
}

function enrollLinkedSubject(
  db: DatabaseSync, subject: Subject, phone: string,
  input: ResolveExternalSubjectInput, options: ResolveExternalSubjectOptions
): Subject {
  if (!options.prepareLinkedPhoneIdentity) return subject;
  // An established phone is never changed by SMS association or account creation.
  if (subject.phoneNumber && normalizeMainlandChinaPhone(subject.phoneNumber) !== phone) throw conflict();
  if (subjects.list(db, { includeArchived:true }).some(
    candidate => candidate.id !== subject.id && normalizeMainlandChinaPhone(candidate.phoneNumber ?? "") === phone
  )) throw conflict();
  if (db.prepare(`SELECT 1 FROM external_subject_registrations
    WHERE phone_number=? AND released_at IS NULL AND (subject_id IS NULL OR subject_id!=?)`).get(phone,subject.id)) throw conflict();
  const prior = registration(db,input.provider,input.externalUserId);
  if (prior && prior.phone_number !== phone) throw conflict();
  const preparedSubject = subject.phoneNumber ? subject : { ...subject,phoneNumber:phone };
  const enrollment = options.prepareLinkedPhoneIdentity(preparedSubject);
  if (enrollment.subjectId !== subject.id) throw conflict();
  // Runtime validation happened before contact changes; every write below rolls back together.
  if (!subject.phoneNumber) subjects.update(db,subject.id,{phoneNumber:phone});
  phoneAuth.enrollExistingIdentityInTransaction(db,enrollment);
  if (!subject.phoneNumber) phoneAuth.recordAudit(db, {
    requestId:input.requestId,action:"prepare_identity",phoneHash:enrollment.phoneHash,
    subjectId:subject.id,sessionId:null,authMethod:null,outcome:"ok",
    reasonCode:"billing_subject_phone_registered",now:input.now ?? new Date()
  });
  return preparedSubject;
}

export function claimCreate(db: DatabaseSync, input: ClaimExternalSubjectInput): string {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const existing = subjects.getByExternal(db, input.provider, input.externalUserId);
    if (existing) {
      throw new GatewayError({ code: "subject_already_exists", message: "External identity is already linked to a subject.", httpStatus: 409 });
    }
    const prior = registration(db, input.provider, input.externalUserId);
    if (prior?.released_at) throw released();
    if (!prior) {
      throw new GatewayError({ code: "identity_link_required", message: "Resolve the verified identity before creating a subject.", httpStatus: 409 });
    }
    if (prior.compensation_state !== "none") throw disabled();
    if (prior.state === "creating") {
      if (prior.idempotency_key !== input.idempotencyKey) {
        throw new GatewayError({ code: "account_pending", message: "The original subject creation event is pending.", httpStatus: 409 });
      }
      if (prior.payload_hash !== input.payloadHash) {
        throw new GatewayError({ code: "idempotency_conflict", message: "The subject creation payload changed.", httpStatus: 409 });
      }
      return prior.phone_number;
    }
    // Recheck under the same lock before allowing any external createUser side effect.
    if (subjects.list(db, { includeArchived: true }).some(
      subject => normalizeMainlandChinaPhone(subject.phoneNumber ?? "") === prior.phone_number
    )) {
      throw new GatewayError({ code: "identity_link_required", message: "Resolve the existing phone account before creating a subject.", httpStatus: 409 });
    }
    db.prepare(`UPDATE external_subject_registrations SET state = 'creating',
      idempotency_key = ?, payload_hash = ?, updated_at = ?
      WHERE provider = ? AND external_user_id = ?`).run(
        input.idempotencyKey, input.payloadHash, (input.now ?? new Date()).toISOString(),
        input.provider, input.externalUserId
      );
    return prior.phone_number;
  });
}

export function completeCreate(db: DatabaseSync, input: ClaimExternalSubjectInput, subjectId: string): void {
  const prior = registration(db, input.provider, input.externalUserId);
  if (!prior) return;
  if (prior.released_at || prior.compensation_state !== "none" || prior.state !== "creating" || prior.idempotency_key !== input.idempotencyKey || prior.payload_hash !== input.payloadHash) {
    throw conflict();
  }
  db.prepare(`UPDATE external_subject_registrations SET state = 'linked', subject_id = ?,
    last_error_code = NULL, last_error_at = NULL, updated_at = ?
    WHERE provider = ? AND external_user_id = ?`).run(
      subjectId, (input.now ?? new Date()).toISOString(), input.provider, input.externalUserId
    );
}

export function recordUpstream(
  db: DatabaseSync,
  input: RecordExternalSubjectUpstreamInput
): void {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const prior = registration(db, input.provider, input.externalUserId);
    if (prior?.state === "linked" && prior.idempotency_key === input.idempotencyKey &&
        prior.payload_hash === input.payloadHash && prior.upstream_user_id === input.upstreamUserId &&
        prior.upstream_key_id === input.upstreamKeyId) {
      return;
    }
    assertMatchingCreate(prior, input);
    if (prior.compensation_state !== "none" ||
        (prior.upstream_user_id && prior.upstream_user_id !== input.upstreamUserId) ||
        (prior.upstream_key_id && prior.upstream_key_id !== input.upstreamKeyId)) throw conflict();
    db.prepare(`UPDATE external_subject_registrations
      SET upstream_user_id = ?, upstream_key_id = ?, last_error_code = NULL,
        last_error_at = NULL, updated_at = ?
      WHERE provider = ? AND external_user_id = ?`).run(
        input.upstreamUserId, input.upstreamKeyId, (input.now ?? new Date()).toISOString(),
        input.provider, input.externalUserId
      );
  });
}

export function beginCompensation(db: DatabaseSync, input: ExternalSubjectCompensationInput): void {
  runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const prior = registration(db, input.provider, input.externalUserId);
    assertMatchingCreate(prior, input);
    if (prior.upstream_user_id !== input.upstreamUserId || prior.upstream_key_id !== input.upstreamKeyId ||
        !input.upstreamUserId || !input.upstreamKeyId || prior.subject_id ||
        subjects.getByExternal(db, input.provider, input.externalUserId) ||
        db.prepare("SELECT 1 FROM upstream_v2_bindings WHERE v2_user_id = ? OR v2_key_id = ?").get(input.upstreamUserId, input.upstreamKeyId)) throw conflict();
    if (prior.compensation_state === "disabled") return;
    db.prepare(`UPDATE external_subject_registrations SET compensation_state = 'pending', updated_at = ?
      WHERE provider = ? AND external_user_id = ?`).run((input.now ?? new Date()).toISOString(), input.provider, input.externalUserId);
    compensationAudit(db, input, "pending");
  });
}

export function completeCompensation(db: DatabaseSync, input: ExternalSubjectCompensationInput): void {
  runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const prior = registration(db, input.provider, input.externalUserId);
    assertMatchingCreate(prior, input);
    if (prior.compensation_state === "none" || prior.upstream_user_id !== input.upstreamUserId ||
        prior.upstream_key_id !== input.upstreamKeyId) throw conflict();
    db.prepare(`UPDATE external_subject_registrations SET compensation_state = 'disabled',
      last_error_code = NULL, last_error_at = NULL, updated_at = ? WHERE provider = ? AND external_user_id = ?`)
      .run((input.now ?? new Date()).toISOString(), input.provider, input.externalUserId);
    compensationAudit(db, input, "disabled");
  });
}

function compensationAudit(db: DatabaseSync, input: ExternalSubjectCompensationInput, state: string): void {
  adminAudit.insert(db, {id: `audit_${randomUUID()}`, action: "disable-user", targetUserId: null,
    targetCredentialId: null, targetCredentialPrefix: null, status: "ok", errorMessage: null,
    createdAt: input.now ?? new Date(), params: {source: "orphan_reconciliation", state,
      actor_id: input.actorId, request_id: input.requestId, provider: input.provider,
      external_user_id: input.externalUserId, upstream_user_id: input.upstreamUserId,
      upstream_key_id: input.upstreamKeyId, original_idempotency_key: input.idempotencyKey}});
}

export function recordCreateFailure(
  db: DatabaseSync,
  input: RecordExternalSubjectCreateFailureInput
): void {
  runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const prior = registration(db, input.provider, input.externalUserId);
    // Never let a late failure overwrite a completed association/disable.
    if ((prior?.state === "linked" || prior?.compensation_state === "disabled" || prior?.released_at) &&
        prior.idempotency_key === input.idempotencyKey && prior.payload_hash === input.payloadHash) return;
    assertMatchingCreate(prior, input);
    const timestamp = (input.now ?? new Date()).toISOString();
    db.prepare(`UPDATE external_subject_registrations
      SET last_error_code = ?, last_error_at = ?, updated_at = ?
      WHERE provider = ? AND external_user_id = ?`).run(
        input.errorCode, timestamp, timestamp, input.provider, input.externalUserId
      );
  });
}

function assertMatchingCreate(
  prior: Registration | null,
  input: ClaimExternalSubjectInput
): asserts prior is Registration {
  if (!prior || prior.released_at || prior.state !== "creating" || prior.idempotency_key !== input.idempotencyKey ||
      prior.payload_hash !== input.payloadHash) {
    throw conflict();
  }
}

function conflict(): GatewayError {
  return new GatewayError({ code: "identity_conflict", message: "External identity or phone account has a conflicting association.", httpStatus: 409 });
}

function disabled(): GatewayError {
  return new GatewayError({ code: "account_disabled", message: "The account is disabled.", httpStatus: 403 });
}

function released(): GatewayError {
  return new GatewayError({code: "registration_released", message: "The original registration was retired by an operator; this external identity cannot restart provisioning.", httpStatus: 409});
}

/** Includes legacy no-phone creates, so absence of upstream IDs cannot imply no call occurred. */
export function recordProvisioningAttempt(db: DatabaseSync, identity: {provider: string; externalUserId: string}, now = new Date()): void {
  runInTransaction(db, "BEGIN IMMEDIATE", () => {
    if (registration(db, identity.provider, identity.externalUserId)?.released_at) throw released();
    db.prepare(`INSERT INTO billing_provisioning_attempts(provider, external_user_id, started_at)
      VALUES (?, ?, ?) ON CONFLICT(provider, external_user_id) DO NOTHING`).run(identity.provider, identity.externalUserId, now.toISOString());
  });
}
