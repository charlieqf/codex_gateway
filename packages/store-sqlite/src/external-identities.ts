import type { DatabaseSync } from "node:sqlite";
import {
  GatewayError,
  normalizeMainlandChinaPhone,
  type ClaimExternalSubjectInput,
  type ExternalSubjectResolution,
  type ResolveExternalSubjectInput
} from "@codex-gateway/core";
import * as subjects from "./subjects.js";
import { runInTransaction } from "./sql.js";

interface Registration {
  provider: string;
  external_user_id: string;
  phone_number: string;
  state: "ready" | "creating" | "linked";
  subject_id: string | null;
  idempotency_key: string | null;
  payload_hash: string | null;
}

export function registration(db: DatabaseSync, provider: string, externalUserId: string): Registration | null {
  return db.prepare(`SELECT provider, external_user_id, phone_number, state,
      subject_id, idempotency_key, payload_hash FROM external_subject_registrations
    WHERE provider = ? AND external_user_id = ?`).get(provider, externalUserId) as Registration | undefined ?? null;
}

export function resolve(db: DatabaseSync, input: ResolveExternalSubjectInput): ExternalSubjectResolution {
  const phone = normalizeMainlandChinaPhone(input.phone);
  if (!phone) {
    throw new GatewayError({ code: "invalid_request", message: "A supported phone number is required.", httpStatus: 400 });
  }
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    // Stable external identity wins after binding, including after a phone change.
    const existing = subjects.getByExternal(db, input.provider, input.externalUserId);
    if (existing) {
      if (existing.state !== "active") throw disabled();
      return { status: "linked", subject: existing };
    }
    const prior = registration(db, input.provider, input.externalUserId);
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
        AND state != 'linked'`).get(phone, input.provider, input.externalUserId);
    if (owner) throw conflict();
    const timestamp = (input.now ?? new Date()).toISOString();
    db.prepare(`INSERT INTO external_subject_registrations
      (provider, external_user_id, phone_number, state, subject_id, request_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_user_id) DO UPDATE SET
        state = excluded.state, subject_id = excluded.subject_id,
        request_id = excluded.request_id, updated_at = excluded.updated_at`).run(
          input.provider, input.externalUserId, phone, subject ? "linked" : "ready",
          subject?.id ?? null, input.requestId, timestamp, timestamp
        );
    return { status: subject ? "linked" : "create_ready", subject };
  });
}

export function claimCreate(db: DatabaseSync, input: ClaimExternalSubjectInput): string {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const existing = subjects.getByExternal(db, input.provider, input.externalUserId);
    if (existing) {
      throw new GatewayError({ code: "subject_already_exists", message: "External identity is already linked to a subject.", httpStatus: 409 });
    }
    const prior = registration(db, input.provider, input.externalUserId);
    if (!prior) {
      throw new GatewayError({ code: "identity_link_required", message: "Resolve the verified identity before creating a subject.", httpStatus: 409 });
    }
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
  if (prior.state !== "creating" || prior.idempotency_key !== input.idempotencyKey || prior.payload_hash !== input.payloadHash) {
    throw conflict();
  }
  db.prepare(`UPDATE external_subject_registrations SET state = 'linked', subject_id = ?, updated_at = ?
    WHERE provider = ? AND external_user_id = ?`).run(
      subjectId, (input.now ?? new Date()).toISOString(), input.provider, input.externalUserId
    );
}

function conflict(): GatewayError {
  return new GatewayError({ code: "identity_conflict", message: "External identity or phone account has a conflicting association.", httpStatus: 409 });
}

function disabled(): GatewayError {
  return new GatewayError({ code: "account_disabled", message: "The account is disabled.", httpStatus: 403 });
}
