import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  GatewayError,
  type CreatePhoneAuthSessionInput,
  type PhoneAuthAuditInput,
  type PhoneAuthIdentity,
  type PhoneAuthIdentityState,
  type PhoneAuthRefreshTokenRecord,
  type PhoneAuthSession,
  type PreparePhoneAuthIdentityInput,
  type RotatePhoneAuthRefreshTokenInput,
  type RotatePhoneAuthRefreshTokenResult,
  type UnifiedClientKeyRecord
} from "@codex-gateway/core";
import { unifiedClientKeyColumns } from "./columns.js";
import { rowToUnifiedClientKey } from "./row-mappers.js";
import { runInTransaction } from "./sql.js";

export function prepareIdentity(
  db: DatabaseSync,
  input: PreparePhoneAuthIdentityInput
): PhoneAuthIdentity {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const subject = db
      .prepare("SELECT state FROM subjects WHERE id = ?")
      .get(input.subjectId) as { state: string } | undefined;
    if (!subject) {
      throw new GatewayError({
        code: "subject_not_found",
        message: "Subject does not exist.",
        httpStatus: 404
      });
    }
    if (subject.state !== "active") {
      throw new GatewayError({
        code: "account_disabled",
        message: "Subject is not active.",
        httpStatus: 403
      });
    }

    const key = db
      .prepare(
        "SELECT subject_id, codex_credential_id, revoked_at, expires_at FROM unified_client_keys WHERE id = ?"
      )
      .get(input.unifiedKeyId) as
      | {
          subject_id: string;
          codex_credential_id: string;
          revoked_at: string | null;
          expires_at: string;
        }
      | undefined;
    if (
      !key ||
      key.subject_id !== input.subjectId ||
      key.revoked_at !== null ||
      new Date(key.expires_at).getTime() <= input.now.getTime()
    ) {
      throw new GatewayError({
        code: "account_migration_required",
        message: "Current unified key is not ready for phone authentication.",
        httpStatus: 409
      });
    }

    const credential = db
      .prepare(
        "SELECT subject_id, revoked_at, expires_at FROM access_credentials WHERE id = ?"
      )
      .get(key.codex_credential_id) as
      | { subject_id: string; revoked_at: string | null; expires_at: string }
      | undefined;
    if (
      !credential ||
      credential.subject_id !== input.subjectId ||
      credential.revoked_at !== null ||
      new Date(credential.expires_at).getTime() <= input.now.getTime()
    ) {
      throw new GatewayError({
        code: "account_migration_required",
        message: "Backing credential is not ready for phone authentication.",
        httpStatus: 409
      });
    }

    const byPhone = getIdentityByPhoneHash(db, input.phoneHash);
    const bySubject = getIdentityBySubjectId(db, input.subjectId);
    if (
      (byPhone && byPhone.subjectId !== input.subjectId) ||
      (bySubject && bySubject.phoneHash !== input.phoneHash)
    ) {
      throw new GatewayError({
        code: "phone_identity_conflict",
        message: "Phone identity conflicts with an existing subject.",
        httpStatus: 409
      });
    }

    db.prepare(
      "UPDATE unified_client_keys SET is_current = 0 WHERE subject_id = ? AND id != ?"
    ).run(input.subjectId, input.unifiedKeyId);
    db.prepare(
      `UPDATE unified_client_keys
       SET token_ciphertext = ?, metadata_json = ?,
           credential_class = 'desktop', is_current = 1
       WHERE id = ?`
    ).run(
      input.unifiedKeyTokenCiphertext,
      JSON.stringify(input.unifiedKeyMetadata),
      input.unifiedKeyId
    );
    db.prepare(
      `UPDATE access_credentials
       SET credential_class = 'desktop', allowed_public_models_json = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(input.backingAllowedPublicModels),
      key.codex_credential_id
    );

    db.prepare(
      `INSERT INTO phone_auth_identities (
         phone_hash, phone_ciphertext, subject_id, unified_key_id, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(phone_hash) DO UPDATE SET
         phone_ciphertext = excluded.phone_ciphertext,
         unified_key_id = excluded.unified_key_id,
         state = 'active',
         updated_at = excluded.updated_at`
    ).run(
      input.phoneHash,
      input.phoneCiphertext,
      input.subjectId,
      input.unifiedKeyId,
      input.now.toISOString(),
      input.now.toISOString()
    );
    insertAudit(db, {
      requestId: input.requestId,
      action: "prepare_identity",
      phoneHash: input.phoneHash,
      subjectId: input.subjectId,
      sessionId: null,
      authMethod: null,
      outcome: "ok",
      reasonCode: null,
      now: input.now
    });
    return mustIdentityByPhoneHash(db, input.phoneHash);
  });
}

export function setIdentityState(
  db: DatabaseSync,
  phoneHash: string,
  state: PhoneAuthIdentityState,
  audit: PhoneAuthAuditInput
): PhoneAuthIdentity | null {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const result = db
      .prepare(
        "UPDATE phone_auth_identities SET state = ?, updated_at = ? WHERE phone_hash = ?"
      )
      .run(state, audit.now.toISOString(), phoneHash);
    if (state === "disabled") {
      const sessions = db
        .prepare(
          "SELECT id FROM phone_auth_sessions WHERE phone_hash = ? AND state = 'active'"
        )
        .all(phoneHash) as Array<{ id: string }>;
      for (const session of sessions) {
        revokeSessionRows(db, session.id, audit.now);
      }
    }
    insertAudit(db, audit);
    return result.changes === 0 ? null : mustIdentityByPhoneHash(db, phoneHash);
  });
}

export function getIdentityByPhoneHash(
  db: DatabaseSync,
  phoneHash: string
): PhoneAuthIdentity | null {
  const row = db
    .prepare(
      `SELECT phone_hash, phone_ciphertext, subject_id, unified_key_id, state,
              created_at, updated_at
       FROM phone_auth_identities WHERE phone_hash = ?`
    )
    .get(phoneHash);
  return row ? rowToIdentity(row) : null;
}

export function getIdentityBySubjectId(
  db: DatabaseSync,
  subjectId: string
): PhoneAuthIdentity | null {
  const row = db
    .prepare(
      `SELECT phone_hash, phone_ciphertext, subject_id, unified_key_id, state,
              created_at, updated_at
       FROM phone_auth_identities WHERE subject_id = ?`
    )
    .get(subjectId);
  return row ? rowToIdentity(row) : null;
}

export function getUnifiedKey(
  db: DatabaseSync,
  unifiedKeyId: string
): UnifiedClientKeyRecord | null {
  const row = db
    .prepare(`SELECT ${unifiedClientKeyColumns} FROM unified_client_keys WHERE id = ?`)
    .get(unifiedKeyId);
  return row ? rowToUnifiedClientKey(row) : null;
}

export function createSession(
  db: DatabaseSync,
  input: CreatePhoneAuthSessionInput
): PhoneAuthSession {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    insertSession(db, input.session);
    insertRefreshToken(db, input.refreshToken);
    insertAudit(db, {
      requestId: input.requestId,
      action: "login",
      phoneHash: input.session.phoneHash,
      subjectId: input.session.subjectId,
      sessionId: input.session.id,
      authMethod: input.session.authMethod,
      outcome: "ok",
      reasonCode: null,
      now: input.session.createdAt
    });
    return input.session;
  });
}

export function getSession(db: DatabaseSync, id: string): PhoneAuthSession | null {
  const row = db
    .prepare(
      `SELECT id, subject_id, phone_hash, device_id, client, auth_method, state,
              absolute_expires_at, revoked_at, created_at, updated_at
       FROM phone_auth_sessions WHERE id = ?`
    )
    .get(id);
  return row ? rowToSession(row) : null;
}

export function rotateRefreshToken(
  db: DatabaseSync,
  input: RotatePhoneAuthRefreshTokenInput
): RotatePhoneAuthRefreshTokenResult {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const token = db
      .prepare(
        `SELECT id, session_id, prefix, hash, generation, state, expires_at,
                rotated_at, created_at
         FROM phone_auth_refresh_tokens WHERE hash = ?`
      )
      .get(input.refreshTokenHash);
    if (!token) {
      insertAudit(db, refreshAudit(input, null, "error", "refresh_token_invalid"));
      return { status: "invalid" };
    }
    const current = rowToRefreshToken(token);
    const session = getSession(db, current.sessionId);
    if (!session) {
      insertAudit(db, refreshAudit(input, null, "error", "refresh_token_invalid"));
      return { status: "invalid" };
    }
    if (current.state !== "active") {
      revokeSessionRows(db, session.id, input.now);
      insertAudit(db, refreshAudit(input, session, "error", "refresh_token_replay"));
      return { status: "replay" };
    }
    if (
      session.state !== "active" ||
      session.deviceId !== input.deviceId ||
      session.absoluteExpiresAt.getTime() <= input.now.getTime() ||
      current.expiresAt.getTime() <= input.now.getTime()
    ) {
      if (session.state === "active") {
        revokeSessionRows(db, session.id, input.now);
      }
      insertAudit(db, refreshAudit(input, session, "error", "refresh_token_invalid"));
      return { status: "invalid" };
    }

    db.prepare(
      "UPDATE phone_auth_refresh_tokens SET state = 'rotated', rotated_at = ? WHERE id = ?"
    ).run(input.now.toISOString(), current.id);
    insertRefreshToken(db, {
      ...input.replacement,
      sessionId: session.id,
      generation: current.generation + 1,
      expiresAt:
        input.replacement.expiresAt.getTime() <= session.absoluteExpiresAt.getTime()
          ? input.replacement.expiresAt
          : session.absoluteExpiresAt
    });
    db.prepare("UPDATE phone_auth_sessions SET updated_at = ? WHERE id = ?").run(
      input.now.toISOString(),
      session.id
    );
    insertAudit(db, refreshAudit(input, session, "ok", null));
    return { status: "ok", session: mustSession(db, session.id) };
  });
}

export function revokeSession(
  db: DatabaseSync,
  id: string,
  audit: PhoneAuthAuditInput
): PhoneAuthSession | null {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const session = getSession(db, id);
    if (!session) {
      insertAudit(db, audit);
      return null;
    }
    revokeSessionRows(db, id, audit.now);
    insertAudit(db, audit);
    return mustSession(db, id);
  });
}

export function recordAudit(db: DatabaseSync, input: PhoneAuthAuditInput): void {
  insertAudit(db, input);
}

function insertSession(db: DatabaseSync, session: PhoneAuthSession): void {
  db.prepare(
    `INSERT INTO phone_auth_sessions (
       id, subject_id, phone_hash, device_id, client, auth_method, state,
       absolute_expires_at, revoked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.subjectId,
    session.phoneHash,
    session.deviceId,
    session.client,
    session.authMethod,
    session.state,
    session.absoluteExpiresAt.toISOString(),
    session.revokedAt?.toISOString() ?? null,
    session.createdAt.toISOString(),
    session.updatedAt.toISOString()
  );
}

function insertRefreshToken(db: DatabaseSync, token: PhoneAuthRefreshTokenRecord): void {
  db.prepare(
    `INSERT INTO phone_auth_refresh_tokens (
       id, session_id, prefix, hash, generation, state, expires_at, rotated_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token.id,
    token.sessionId,
    token.prefix,
    token.hash,
    token.generation,
    token.state,
    token.expiresAt.toISOString(),
    token.rotatedAt?.toISOString() ?? null,
    token.createdAt.toISOString()
  );
}

function revokeSessionRows(db: DatabaseSync, id: string, now: Date): void {
  db.prepare(
    `UPDATE phone_auth_sessions
     SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
     WHERE id = ?`
  ).run(now.toISOString(), now.toISOString(), id);
  db.prepare(
    "UPDATE phone_auth_refresh_tokens SET state = 'revoked' WHERE session_id = ? AND state = 'active'"
  ).run(id);
}

function insertAudit(db: DatabaseSync, input: PhoneAuthAuditInput): void {
  db.prepare(
    `INSERT INTO phone_auth_audit_events (
       id, request_id, action, phone_hash, subject_id, session_id, auth_method,
       outcome, reason_code, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `pha_${randomUUID().replaceAll("-", "")}`,
    input.requestId,
    input.action,
    input.phoneHash,
    input.subjectId,
    input.sessionId,
    input.authMethod,
    input.outcome,
    input.reasonCode,
    input.now.toISOString()
  );
}

function refreshAudit(
  input: RotatePhoneAuthRefreshTokenInput,
  session: PhoneAuthSession | null,
  outcome: "ok" | "error",
  reasonCode: string | null
): PhoneAuthAuditInput {
  return {
    requestId: input.requestId,
    action: "refresh",
    phoneHash: session?.phoneHash ?? null,
    subjectId: session?.subjectId ?? null,
    sessionId: session?.id ?? null,
    authMethod: session?.authMethod ?? null,
    outcome,
    reasonCode,
    now: input.now
  };
}

function mustIdentityByPhoneHash(db: DatabaseSync, phoneHash: string): PhoneAuthIdentity {
  const identity = getIdentityByPhoneHash(db, phoneHash);
  if (!identity) {
    throw new Error("Phone auth identity write did not persist.");
  }
  return identity;
}

function mustSession(db: DatabaseSync, id: string): PhoneAuthSession {
  const session = getSession(db, id);
  if (!session) {
    throw new Error("Phone auth session write did not persist.");
  }
  return session;
}

function rowToIdentity(row: unknown): PhoneAuthIdentity {
  const value = row as {
    phone_hash: string;
    phone_ciphertext: string;
    subject_id: string;
    unified_key_id: string;
    state: PhoneAuthIdentity["state"];
    created_at: string;
    updated_at: string;
  };
  return {
    phoneHash: value.phone_hash,
    phoneCiphertext: value.phone_ciphertext,
    subjectId: value.subject_id,
    unifiedKeyId: value.unified_key_id,
    state: value.state,
    createdAt: new Date(value.created_at),
    updatedAt: new Date(value.updated_at)
  };
}

function rowToSession(row: unknown): PhoneAuthSession {
  const value = row as {
    id: string;
    subject_id: string;
    phone_hash: string;
    device_id: string;
    client: PhoneAuthSession["client"];
    auth_method: PhoneAuthSession["authMethod"];
    state: PhoneAuthSession["state"];
    absolute_expires_at: string;
    revoked_at: string | null;
    created_at: string;
    updated_at: string;
  };
  return {
    id: value.id,
    subjectId: value.subject_id,
    phoneHash: value.phone_hash,
    deviceId: value.device_id,
    client: value.client,
    authMethod: value.auth_method,
    state: value.state,
    absoluteExpiresAt: new Date(value.absolute_expires_at),
    revokedAt: value.revoked_at ? new Date(value.revoked_at) : null,
    createdAt: new Date(value.created_at),
    updatedAt: new Date(value.updated_at)
  };
}

function rowToRefreshToken(row: unknown): PhoneAuthRefreshTokenRecord {
  const value = row as {
    id: string;
    session_id: string;
    prefix: string;
    hash: string;
    generation: number;
    state: PhoneAuthRefreshTokenRecord["state"];
    expires_at: string;
    rotated_at: string | null;
    created_at: string;
  };
  return {
    id: value.id,
    sessionId: value.session_id,
    prefix: value.prefix,
    hash: value.hash,
    generation: value.generation,
    state: value.state,
    expiresAt: new Date(value.expires_at),
    rotatedAt: value.rotated_at ? new Date(value.rotated_at) : null,
    createdAt: new Date(value.created_at)
  };
}
