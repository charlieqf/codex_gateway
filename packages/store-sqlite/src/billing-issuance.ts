import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, GatewayError, normalizeMainlandChinaPhone, type BillingIssuanceInspection } from "@codex-gateway/core";
import * as subjects from "./subjects.js";
import * as credentials from "./access-credentials.js";
import * as keys from "./unified-client-keys.js";
import * as phoneAuth from "./phone-auth.js";
import * as entitlements from "./entitlement-queries.js";
import * as registrations from "./external-identities.js";
import { runInTransaction } from "./sql.js";

/** Read-only fences can also run inside a caller's write transaction (disable/grant).
 * Normalization owns its transaction and repeats every fence under that lock. */
export function inspect(db: DatabaseSync, input: BillingIssuanceInspection): { upstreamUserId: string; upstreamKeyId: string } {
  if (input.normalize) return runInTransaction(db, "BEGIN IMMEDIATE", () => inspectLocked(db, input));
  return inspectLocked(db, input);
}

function inspectLocked(db: DatabaseSync, input: BillingIssuanceInspection) {
  input.assertOwnership();
  const refuse = (message: string): never => {
    throw new GatewayError({code: "issue_recovery_requires_review", message, httpStatus: 409});
  };
  // The create event and registration are the durable original target, not the
  // mutable current binding. This also works after a crash before a job checkpoint.
  const event = db.prepare(`SELECT credential_id, unified_key_id FROM billing_subject_events
    WHERE idempotency_key=? AND subject_id=? AND provider=? AND external_user_id=?
      AND event_type='create_subject' AND status='applied'`).get(
      `${input.taskId}:create_subject`, input.subjectId, input.provider, input.externalUserId
    ) as {credential_id: string; unified_key_id: string} | undefined;
  const registration = registrations.registration(db, input.provider, input.externalUserId);
  const binding = db.prepare("SELECT v2_user_id, v2_key_id, state FROM upstream_v2_bindings WHERE subject_id=?")
    .get(input.subjectId) as {v2_user_id: string; v2_key_id: string; state: string} | undefined;
  if (!event || !registration || registration.released_at || registration.state !== "linked" ||
      registration.subject_id !== input.subjectId || registration.idempotency_key !== `${input.taskId}:create_subject` ||
      !registration.upstream_user_id || !registration.upstream_key_id || !binding ||
      binding.v2_user_id !== registration.upstream_user_id || binding.v2_key_id !== registration.upstream_key_id) {
    return refuse("Original issuance binding or registration changed; inspect the original task before recovery.");
  }
  const subject = subjects.get(db, input.subjectId);
  const subjectKeys = keys.list(db, {subjectId: input.subjectId});
  const key = subjectKeys.find(candidate => candidate.id === event.unified_key_id);
  const subjectCredentials = credentials.list(db, {subjectId: input.subjectId});
  const backing = subjectCredentials.find(candidate => candidate.id === event.credential_id);
  const phone = phoneAuth.getIdentityBySubjectId(db, input.subjectId);
  const byPhone = phoneAuth.getIdentityByPhoneHash(db, input.phoneHash);
  const state = input.disabled ? "disabled" : "active";
  if (!subject || subject.state !== state || subject.externalProvider !== input.provider ||
      subject.externalUserId !== input.externalUserId || normalizeMainlandChinaPhone(subject.phoneNumber ?? "") !== input.phone ||
      subject.label !== input.name || (subject.name != null && subject.name !== input.name) ||
      !key || !backing || key.metadata?.issuance_task_id !== input.taskId || key.codexCredentialId !== backing.id ||
      key.codexCredentialPrefix !== backing.prefix || key.credentialClass !== "desktop" || backing.credentialClass !== "desktop" ||
      backing.scope !== input.scope || canonicalJson(backing.allowedPublicModels) !== canonicalJson(input.allowedPublicModels) ||
      !phone || phone.state !== state || phone.phoneHash !== input.phoneHash || phone.unifiedKeyId !== key.id ||
      byPhone?.subjectId !== subject.id) {
    return refuse("Original account, key or phone login changed; automatic issuance recovery is refused.");
  }
  const rate = (value: typeof input.rate) => ({...value, token: value.token ?? null});
  if (backing.expiresAt.getTime() !== input.keyExpiresAt.getTime() || key.expiresAt.getTime() !== input.keyExpiresAt.getTime() ||
      canonicalJson(rate(backing.rate)) !== canonicalJson(rate(input.rate)) ||
      ![`Billing ${input.provider}`, input.credentialLabel].includes(backing.label)) {
    return refuse("Credential expiry, rate or label changed; recovery must not overwrite later operator changes.");
  }
  const grant = db.prepare("SELECT entitlement_id FROM billing_events WHERE idempotency_key=? AND status='applied'")
    .get(`${input.provider}:${input.externalUserId}:purchase:${input.taskId}`) as {entitlement_id: string} | undefined;
  const allEntitlements = entitlements.list(db, {subjectId: input.subjectId});
  const original = allEntitlements.find(candidate => candidate.id === grant?.entitlement_id);
  const live = allEntitlements.filter(candidate => ["active", "paused", "scheduled"].includes(candidate.state));
  if (input.disabled) {
    if (binding.state === "active" || !key.revokedAt || !backing.revokedAt || live.length ||
        subjectKeys.some(candidate => !candidate.revokedAt) || subjectCredentials.some(candidate => !candidate.revokedAt)) {
      return refuse("Account was restored or received new access after local disable; automatic upstream disable is refused.");
    }
  } else if (binding.state !== "active" || !key.isCurrent || key.revokedAt || backing.revokedAt ||
      !key.tokenCiphertext || key.expiresAt <= input.now || backing.expiresAt <= input.now ||
      subjectKeys.some(candidate => candidate.id !== key.id && !candidate.revokedAt) ||
      subjectCredentials.some(candidate => candidate.id !== backing.id && !candidate.revokedAt)) {
    return refuse("Original runtime credentials changed; automatic issuance recovery is refused.");
  }
  if ((grant && (!original || original.planId !== input.planId || original.periodKind !== "one_off" ||
        original.periodStart?.getTime() !== input.periodStart.getTime() || original.periodEnd?.getTime() !== input.entitlementEnd.getTime() ||
        original.state !== (input.disabled ? "cancelled" : "active"))) ||
      (!grant && input.requireEntitlement) || live.some(candidate => candidate.id !== original?.id)) {
    return refuse("Original entitlement changed; recovery must not overwrite later purchases, renewals or cancellations.");
  }
  if (input.normalize) {
    // Expiry/rate and phone enrollment were committed atomically during creation.
    // Only finish the original cosmetic metadata; never replay authority writes.
    subjects.update(db, input.subjectId, {label: input.name, name: input.name, phoneNumber: input.phone});
    db.prepare("UPDATE access_credentials SET label=? WHERE id=?").run(input.credentialLabel, backing.id);
  }
  return {upstreamUserId: registration.upstream_user_id, upstreamKeyId: registration.upstream_key_id};
}
