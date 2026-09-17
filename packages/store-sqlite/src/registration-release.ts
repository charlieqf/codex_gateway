import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { GatewayError } from "@codex-gateway/core";
import { runInTransaction } from "./sql.js";
import * as subjects from "./subjects.js";
import * as adminAudit from "./admin-audit.js";

export interface RegistrationReleaseInput {
  provider: string;
  externalUserId: string;
  actor: string;
  reason: string;
  dryRun: boolean;
  expectedRevision?: string;
  now?: Date;
}

/** Read-only preview or an atomic, audited release. Never deletes history or enables an account. */
export function releaseExternalSubjectRegistration(db: DatabaseSync, input: RegistrationReleaseInput) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.provider) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.externalUserId) ||
      !input.actor.trim() || input.actor.length > 128 || !input.reason.trim() || input.reason.length > 500) {
    throw refused("Explicit identity, operator and release reason are required.");
  }
  return runInTransaction(db, input.dryRun ? "BEGIN" : "BEGIN IMMEDIATE", () => {
    const registration = db.prepare("SELECT * FROM external_subject_registrations WHERE provider = ? AND external_user_id = ?")
      .get(input.provider, input.externalUserId) as Record<string, string | number | null> | undefined;
    if (!registration || registration.released_at) throw refused("Registration is missing or already released.");
    const tasks = db.prepare(`SELECT id, state, updated_at, retired_at FROM real_user_issuance_tasks
      WHERE provider = ? AND external_user_id = ? ORDER BY id`).all(input.provider, input.externalUserId) as Array<{id: string; state: string; retired_at: string | null}>;
    const attempted = db.prepare("SELECT started_at FROM billing_provisioning_attempts WHERE provider = ? AND external_user_id = ?")
      .get(input.provider, input.externalUserId);
    const revision = createHash("sha256").update(JSON.stringify({registration, tasks, attempted: attempted ?? null})).digest("hex");
    if (registration.subject_id || subjects.getByExternal(db, input.provider, input.externalUserId) ||
        tasks.some(task => task.state === "succeeded") ||
        db.prepare("SELECT 1 FROM upstream_v2_bindings WHERE v2_user_id = ? OR v2_key_id = ?")
          .get(registration.upstream_user_id ?? null, registration.upstream_key_id ?? null)) {
      throw refused("An account, successful task or upstream binding still references this identity; release is refused.");
    }
    const neverStarted = registration.state === "ready" && registration.release_eligible === 1 && !attempted &&
      !registration.upstream_user_id && !registration.upstream_key_id;
    const confirmedDisabled = registration.state === "creating" && registration.compensation_state === "disabled" &&
      Boolean(registration.upstream_user_id && registration.upstream_key_id);
    if (!neverStarted && !confirmedDisabled) {
      throw refused("Creation may have reached upstream. Missing IDs or an expired lease do not prove absence; reconcile/disable first. Historical ready rows need manual reconciliation.");
    }
    const result = {provider: input.provider, external_user_id: input.externalUserId,
      phone_tail: String(registration.phone_number).slice(-4), state: registration.state,
      upstream_user_id: registration.upstream_user_id, upstream_key_id: registration.upstream_key_id,
      task_ids: tasks.map(task => task.id), revision, release_basis: neverStarted ? "never_started" : "upstream_disable_confirmed",
      applied: !input.dryRun, original_identity_retired: true};
    if (input.dryRun) return result;
    if (!input.expectedRevision || input.expectedRevision !== revision) throw refused("Registration changed or no preview revision supplied; run dry-run again.");
    const timestamp = (input.now ?? new Date()).toISOString();
    // Fence running workers before unlocking the phone, in the same transaction.
    db.prepare(`UPDATE real_user_issuance_tasks SET retired_at = ?, lease_token = NULL, lease_expires_at = NULL
      WHERE provider = ? AND external_user_id = ? AND retired_at IS NULL`).run(timestamp, input.provider, input.externalUserId);
    db.prepare(`UPDATE external_subject_registrations SET released_at = ?, release_actor = ?, release_reason = ?, updated_at = ?
      WHERE provider = ? AND external_user_id = ?`).run(timestamp, input.actor, input.reason, timestamp, input.provider, input.externalUserId);
    adminAudit.insert(db, {id: `audit_${randomUUID()}`, action: "registration-release", targetUserId: null,
      targetCredentialId: null, targetCredentialPrefix: null, status: "ok", errorMessage: null,
      createdAt: input.now ?? new Date(), params: {...result, actor: input.actor, reason: input.reason}});
    return result;
  });
}

function refused(message: string): GatewayError {
  return new GatewayError({code: "registration_release_refused", message, httpStatus: 409});
}
