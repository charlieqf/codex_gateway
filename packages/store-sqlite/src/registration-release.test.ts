import { afterEach, describe, expect, it } from "vitest";
import { createSqliteStore } from "./index.js";
import { releaseExternalSubjectRegistration } from "./registration-release.js";
import { migrateGatewaySchema } from "./migrations.js";

const stores: ReturnType<typeof createSqliteStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const now = new Date("2026-09-17T00:00:00Z");
const identity = {provider: "manual_trial", externalUserId: "release-test"};
const original = {...identity, idempotencyKey: "create-test", payloadHash: "hash-test"};
const upstream = {...original, upstreamUserId: "upstream-test", upstreamKeyId: "upstream-key-test"};
const compensation = {...upstream, actorId: "operator-test", requestId: "request-test"};

function fixture() {
  const store = createSqliteStore({path: ":memory:"});
  stores.push(store);
  store.resolveExternalSubject({...identity, phone: "13800138000", requestId: "request-test", now});
  const input = {...identity, actor: "operator-test", reason: "Abandoned test issuance", now};
  const preview = () => releaseExternalSubjectRegistration(store.database, {...input, dryRun: true});
  const apply = (expectedRevision = preview().revision) => releaseExternalSubjectRegistration(store.database, {...input, dryRun: false, expectedRevision});
  return {store, preview, apply};
}

describe("audited registration release", () => {
  it("upgrades schema 32 preserving task ciphertext, leases and historical reservation uncertainty", () => {
    const {store, preview} = fixture();
    const db = store.database;
    // Reconstruct the previous schema in this isolated in-memory database only.
    db.exec(`DROP TABLE real_user_issuance_tasks;
      CREATE TABLE real_user_issuance_tasks (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_user_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, state TEXT NOT NULL, snapshot_ciphertext TEXT NOT NULL,
        lease_token TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(provider, external_user_id));
      DROP TABLE billing_provisioning_attempts;
      DROP INDEX idx_external_subject_registration_pending_phone;
      ALTER TABLE external_subject_registrations DROP COLUMN released_at;
      ALTER TABLE external_subject_registrations DROP COLUMN release_actor;
      ALTER TABLE external_subject_registrations DROP COLUMN release_reason;
      ALTER TABLE external_subject_registrations DROP COLUMN release_eligible;
      CREATE UNIQUE INDEX idx_external_subject_registration_pending_phone ON external_subject_registrations(phone_number) WHERE state != 'linked';
      DELETE FROM schema_migrations WHERE version = 33;`);
    db.prepare(`INSERT INTO real_user_issuance_tasks VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      "old-job", identity.provider, identity.externalUserId, "operator", "running", "original-ciphertext",
      "original-lease", new Date(now.getTime() + 120_000).toISOString(), now.toISOString(), now.toISOString());
    migrateGatewaySchema(db);
    expect(store.getIssuanceTask("old-job")).toMatchObject({state: "running", snapshotCiphertext: "original-ciphertext",
      leaseToken: "original-lease", retiredAt: null, leaseExpiresAt: new Date(now.getTime() + 120_000)});
    expect(() => preview()).toThrow(/Historical ready/);
    expect(db.prepare("PRAGMA quick_check").get()).toMatchObject({quick_check: "ok"});
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    migrateGatewaySchema(db);
    expect(store.getIssuanceTask("old-job")?.snapshotCiphertext).toBe("original-ciphertext");
  });

  it("previews without writes, requires an unchanged revision and fences workers while freeing only the phone", () => {
    const {store, preview, apply} = fixture();
    store.insertIssuanceTask({id: "job-test", ...identity, actorId: "operator-test", state: "queued",
      snapshotCiphertext: "encrypted-test-snapshot", leaseToken: null, leaseExpiresAt: null, createdAt: now, updatedAt: now});
    expect(store.claimIssuanceTask("job-test", "lease-test", now, new Date(now.getTime() + 120_000), "queued")).toBe(true);
    const before = store.getExternalSubjectRegistration(identity);
    store.database.exec("PRAGMA query_only = ON");
    const plan = preview();
    store.database.exec("PRAGMA query_only = OFF");
    expect(plan).toMatchObject({applied: false, release_basis: "never_started", phone_tail: "8000"});
    expect(store.getExternalSubjectRegistration(identity)).toEqual(before);
    expect(store.listAdminAuditEvents({action: "registration-release"})).toEqual([]);
    expect(() => apply("invalid-revision")).toThrow(/preview/);
    expect(apply(plan.revision).applied).toBe(true);
    expect(store.getIssuanceTask("job-test")).toMatchObject({retiredAt: now, leaseToken: null});
    expect(store.claimIssuanceTask("job-test", "late-lease", now, new Date(now.getTime() + 120_000), "queued")).toBe(false);
    expect(() => store.saveIssuanceTask(store.getIssuanceTask("job-test")!, "lease-test", now)).toThrow(/ownership/);
    expect(store.getExternalSubjectRegistration(identity)?.releasedAt).toEqual(now);
    const audits = store.listAdminAuditEvents({action: "registration-release"});
    expect(audits).toHaveLength(1);
    expect(audits[0]?.params).toMatchObject({actor: "operator-test", reason: "Abandoned test issuance"});
    expect(JSON.stringify(audits)).not.toContain("13800138000");
    expect(() => store.resolveExternalSubject({...identity, phone: "13800138000", requestId: "late"})).toThrow(/retired/);
    expect(() => store.claimExternalSubjectCreate(original)).toThrow(/retired/);
    expect(() => store.recordBillingProvisioningAttempt(identity)).toThrow(/retired/);
    expect(store.resolveExternalSubject({provider: "identity_backend", externalUserId: "actual-user",
      phone: "13800138000", requestId: "new"})).toMatchObject({status: "create_ready"});
    expect(() => apply()).toThrow(/already released/);
  });

  it.each(["historical-ready", "ready-call-started", "creating-no-ids", "creating-with-ids", "pending-disable"])(
    "refuses uncertain upstream state: %s", state => {
      const {store, preview} = fixture();
      if (state === "historical-ready") store.database.exec("UPDATE external_subject_registrations SET release_eligible = 0");
      else if (state === "ready-call-started") store.recordBillingProvisioningAttempt(identity);
      else {
        store.claimExternalSubjectCreate(original);
        store.recordBillingProvisioningAttempt(identity);
        if (state !== "creating-no-ids") store.recordExternalSubjectUpstream(upstream);
        if (state === "pending-disable") store.beginExternalSubjectCompensation(compensation);
      }
      expect(() => preview()).toThrow(/reconcile/);
      expect(store.getExternalSubjectRegistration(identity)?.releasedAt).toBeNull();
    }
  );

  it("refuses a stale preview if a legacy no-phone call has started", () => {
    const {store, preview, apply} = fixture();
    const plan = preview();
    store.recordBillingProvisioningAttempt(identity);
    expect(() => apply(plan.revision)).toThrow(/reconcile/);
  });

  it("rolls back both task retirement and phone release if the audit write fails", () => {
    const {store, apply} = fixture();
    store.insertIssuanceTask({id: "audit-test", ...identity, actorId: "operator-test", state: "queued",
      snapshotCiphertext: "encrypted-test", leaseToken: null, leaseExpiresAt: null, createdAt: now, updatedAt: now});
    store.database.exec(`CREATE TRIGGER fail_release_audit BEFORE INSERT ON admin_audit_events
      WHEN NEW.action = 'registration-release' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;`);
    expect(() => apply()).toThrow(/audit failure/);
    expect(store.getExternalSubjectRegistration(identity)?.releasedAt).toBeNull();
    expect(store.getIssuanceTask("audit-test")?.retiredAt).toBeNull();
    expect(() => store.resolveExternalSubject({provider: "identity_backend", externalUserId: "other-test",
      phone: "13800138000", requestId: "test"})).toThrow(/conflicting/);
  });

  it("allows confirmed orphan disable, retains evidence and rejects late commits", () => {
    const {store, preview, apply} = fixture();
    store.claimExternalSubjectCreate(original);
    store.recordBillingProvisioningAttempt(identity);
    store.recordExternalSubjectUpstream(upstream);
    store.beginExternalSubjectCompensation(compensation);
    store.completeExternalSubjectCompensation(compensation);
    expect(preview().release_basis).toBe("upstream_disable_confirmed");
    apply();
    expect(store.getExternalSubjectRegistration(identity)).toMatchObject({releasedAt: now, upstreamUserId: "upstream-test", compensationState: "disabled"});
    expect(() => store.recordExternalSubjectUpstream(upstream)).toThrow(/conflicting/);
    expect(() => store.beginExternalSubjectCompensation(compensation)).toThrow(/conflicting/);
    expect(() => store.recordBillingProvisioningAttempt(identity)).toThrow(/retired/);
  });

  it("never releases an identity with an existing account", () => {
    const {store, preview} = fixture();
    store.upsertSubject({id: "existing-test", label: "Existing", state: "disabled", externalProvider: identity.provider,
      externalUserId: identity.externalUserId, createdAt: now});
    expect(() => preview()).toThrow(/account/);
  });

  it("retains failed history but permits corrected attempts; live or successful identities remain unique", () => {
    const {store} = fixture();
    const task = {id: "old", ...identity, actorId: "operator-test", state: "failed", snapshotCiphertext: "encrypted-test",
      leaseToken: null, leaseExpiresAt: null, createdAt: now, updatedAt: now};
    store.insertIssuanceTask(task);
    store.insertIssuanceTask({...task, id: "new", state: "queued"});
    expect(store.listIssuanceTasks(null, 20)).toHaveLength(2);
    expect(() => store.insertIssuanceTask({...task, id: "duplicate", state: "queued"})).toThrow(/already exists/);
    store.database.exec("UPDATE real_user_issuance_tasks SET state = 'succeeded' WHERE id = 'new'");
    expect(() => store.insertIssuanceTask({...task, id: "duplicate", state: "queued"})).toThrow(/already exists/);
  });
});
