import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptSecret,
  issueAccessCredential,
  issueUnifiedClientKey
} from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import {
  PhoneAuthService,
  phoneAuthGatewayOrigin,
  phoneAuthMedevidenceOrigin
} from "./phone-auth-service.js";

const start = new Date("2026-08-20T00:00:00.000Z");
const phoneSecret = "phone-lookup-secret-32-characters-minimum";
const phoneEncryptionSecret = "phone-encryption-secret-32-characters-min";
const recoverySecret = "unified-recovery-secret-32-characters-min";

describe("PhoneAuthService", () => {
  it("logs in only a prepared account and returns one consistent runtime identity", () => {
    const fixture = createFixture();
    const identity = fixture.service.prepareIdentity({
      phone: "13800138000",
      subjectId: fixture.subjectId,
      unifiedKey: fixture.unified.token,
      requestId: "req_prepare"
    });
    expect(identity.subjectId).toBe(fixture.subjectId);

    const login = fixture.service.login({
      phone: "13800138000",
      deviceId: "desktop-device-example-01",
      requestId: "req_login"
    });
    expect(login).toMatchObject({
      status: "authenticated",
      auth_method: "transition_phone_only",
      expires_in_seconds: 900,
      refresh_idle_expires_in_seconds: 2_592_000,
      subject: { id: fixture.subjectId, state: "active" }
    });

    const bootstrap = fixture.service.bootstrap(login.access_token, "req_bootstrap");
    const account = fixture.service.accountCurrent(login.access_token, "req_account");
    expect(bootstrap).toMatchObject({
      subject: { id: fixture.subjectId },
      unified_key: {
        key: fixture.unified.token,
        key_prefix: `cgu_live_${fixture.unified.record.prefix}`,
        expires_at: fixture.unified.record.expiresAt.toISOString()
      },
      resolver_url: `${phoneAuthGatewayOrigin}/gateway/unified-keys/resolve`,
      account_url: `${phoneAuthGatewayOrigin}/gateway/account/v1/current`
    });
    expect(account).toMatchObject({
      subject: { id: fixture.subjectId },
      identity: { kind: "internal", plan_id: "plan_internal" },
      token_wallet: null,
      image_credits: null
    });
    expect(account.capabilities).toContain("chat");
    expect(
      JSON.stringify(
        fixture.store.database
          .prepare("SELECT * FROM phone_auth_audit_events ORDER BY created_at")
          .all()
      )
    ).not.toContain("13800138000");
    expect(
      JSON.stringify(
        fixture.store.database
          .prepare("SELECT * FROM phone_auth_audit_events ORDER BY created_at")
          .all()
      )
    ).not.toContain(fixture.unified.token);
    fixture.store.close();
  });

  it("rotates refresh tokens and revokes the Session family when an old token is replayed", () => {
    const fixture = createFixture();
    fixture.service.prepareIdentity({
      phone: "13800138000",
      subjectId: fixture.subjectId,
      unifiedKey: fixture.unified.token,
      requestId: "req_prepare"
    });
    const login = fixture.service.login({
      phone: "13800138000",
      deviceId: "desktop-device-example-01",
      requestId: "req_login"
    });
    fixture.setNow(new Date("2026-08-21T00:00:00.000Z"));
    const refreshed = fixture.service.refresh({
      refreshToken: login.refresh_token,
      deviceId: "desktop-device-example-01",
      requestId: "req_refresh"
    });
    expect(refreshed.refresh_token).not.toBe(login.refresh_token);
    expect(() =>
      fixture.service.refresh({
        refreshToken: login.refresh_token,
        deviceId: "desktop-device-example-01",
        requestId: "req_replay"
      })
    ).toThrowError(expect.objectContaining({ code: "refresh_token_invalid" }));
    expect(() =>
      fixture.service.refresh({
        refreshToken: refreshed.refresh_token,
        deviceId: "desktop-device-example-01",
        requestId: "req_after_replay"
      })
    ).toThrowError(expect.objectContaining({ code: "refresh_token_invalid" }));
    expect(() =>
      fixture.service.bootstrap(refreshed.access_token, "req_bootstrap")
    ).toThrowError(expect.objectContaining({ code: "access_token_invalid" }));
    fixture.store.close();
  });

  it("keeps logout idempotent for a recognized signed access token", () => {
    const fixture = createFixture();
    fixture.service.prepareIdentity({
      phone: "13800138000",
      subjectId: fixture.subjectId,
      unifiedKey: fixture.unified.token,
      requestId: "req_prepare"
    });
    const login = fixture.service.login({
      phone: "13800138000",
      deviceId: "desktop-device-example-01",
      requestId: "req_login"
    });
    expect(() => fixture.service.logout(login.access_token, "req_logout_1")).not.toThrow();
    expect(() => fixture.service.logout(login.access_token, "req_logout_2")).not.toThrow();
    expect(() =>
      fixture.service.bootstrap(login.access_token, "req_bootstrap")
    ).toThrowError(expect.objectContaining({ code: "access_token_invalid" }));
    fixture.store.close();
  });

  it("does not create data for an unknown phone", () => {
    const fixture = createFixture();
    expect(() =>
      fixture.service.login({
        phone: "13900139000",
        deviceId: "desktop-device-example-01",
        requestId: "req_unknown"
      })
    ).toThrowError(expect.objectContaining({ code: "phone_not_registered" }));
    expect(fixture.store.listSubjects()).toHaveLength(1);
    expect(fixture.store.listUnifiedClientKeys()).toHaveLength(1);
    expect(
      fixture.store.database.prepare("SELECT COUNT(*) AS count FROM phone_auth_sessions").get()
    ).toMatchObject({ count: 0 });
    fixture.store.close();
  });

  it("prepares only the unique phone already registered on the Subject", () => {
    const fixture = createFixture();
    expect(() =>
      fixture.service.prepareIdentity({
        phone: "13900139000",
        subjectId: fixture.subjectId,
        unifiedKey: fixture.unified.token,
        requestId: "req_mismatch"
      })
    ).toThrowError(
      expect.objectContaining({ code: "account_migration_required" })
    );
    fixture.store.upsertSubject({
      id: "subj_duplicate",
      label: "Duplicate",
      phoneNumber: "+8613800138000",
      state: "active",
      createdAt: start
    });
    expect(() =>
      fixture.service.prepareIdentity({
        phone: "13800138000",
        subjectId: fixture.subjectId,
        unifiedKey: fixture.unified.token,
        requestId: "req_duplicate"
      })
    ).toThrowError(expect.objectContaining({ code: "phone_identity_conflict" }));
    fixture.store.close();
  });

  it("rechecks the Subject phone mapping before login", () => {
    const changed = createFixture();
    changed.service.prepareIdentity({
      phone: "13800138000",
      subjectId: changed.subjectId,
      unifiedKey: changed.unified.token,
      requestId: "req_prepare"
    });
    changed.store.updateSubject(changed.subjectId, {
      phoneNumber: "+8613900139000"
    });
    expect(() =>
      changed.service.login({
        phone: "13800138000",
        deviceId: "desktop-device-example-01",
        requestId: "req_changed"
      })
    ).toThrowError(
      expect.objectContaining({ code: "account_migration_required" })
    );
    changed.store.close();

    const duplicate = createFixture();
    duplicate.service.prepareIdentity({
      phone: "13800138000",
      subjectId: duplicate.subjectId,
      unifiedKey: duplicate.unified.token,
      requestId: "req_prepare"
    });
    duplicate.store.upsertSubject({
      id: "subj_duplicate",
      label: "Duplicate",
      phoneNumber: "+8613800138000",
      state: "active",
      createdAt: start
    });
    expect(() =>
      duplicate.service.login({
        phone: "13800138000",
        deviceId: "desktop-device-example-01",
        requestId: "req_duplicate"
      })
    ).toThrowError(
      expect.objectContaining({ code: "phone_identity_conflict" })
    );
    duplicate.store.close();
  });

  it("accepts only the approved MedEvidence origin", () => {
    const fixture = createFixture();
    fixture.store.database
      .prepare("UPDATE unified_client_keys SET metadata_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ medevidence_base_url: "https://wrong.example" }),
        fixture.unified.record.id
      );
    expect(() =>
      fixture.service.prepareIdentity({
        phone: "13800138000",
        subjectId: fixture.subjectId,
        unifiedKey: fixture.unified.token,
        requestId: "req_wrong_origin"
      })
    ).toThrowError(
      expect.objectContaining({ code: "account_migration_required" })
    );
    fixture.store.close();
  });

  it("normalizes missing legacy Desktop routing fields during preparation", () => {
    const fixture = createFixture();
    fixture.store.database
      .prepare("UPDATE unified_client_keys SET metadata_json = NULL WHERE id = ?")
      .run(fixture.unified.record.id);
    fixture.store.database
      .prepare("UPDATE access_credentials SET allowed_public_models_json = NULL WHERE id = ?")
      .run(fixture.backing.record.id);

    fixture.service.prepareIdentity({
      phone: "13800138000",
      subjectId: fixture.subjectId,
      unifiedKey: fixture.unified.token,
      requestId: "req_prepare_legacy"
    });

    expect(
      fixture.store.getUnifiedClientKeyByPrefix(fixture.unified.record.prefix)
        ?.metadata
    ).toEqual({ medevidence_base_url: phoneAuthMedevidenceOrigin });
    expect(
      fixture.store.getAccessCredentialByPrefix(fixture.backing.record.prefix)
        ?.allowedPublicModels
    ).toEqual(["goldencode"]);
    fixture.store.close();
  });
});

function createFixture() {
  const subjectId = "subj_internal";
  const store = createSqliteStore({ path: ":memory:" });
  store.upsertSubject({
    id: subjectId,
    label: "Internal user",
    phoneNumber: "+8613800138000",
    state: "active",
    createdAt: start
  });
  store.createPlan({
    id: "plan_internal",
    displayName: "Internal",
    policy: {
      tokensPerMinute: null,
      tokensPerDay: null,
      tokensPerMonth: null,
      maxPromptTokensPerRequest: null,
      maxTotalTokensPerRequest: null,
      reserveTokensPerRequest: 0,
      missingUsageCharge: "none"
    },
    featurePolicy: {
      capabilities: ["chat", "tools"],
      imageGeneration: null,
      medcodeModels: null
    },
    scopeAllowlist: ["code"],
    now: start
  });
  store.grantEntitlement({
    subjectId,
    planId: "plan_internal",
    periodKind: "unlimited",
    now: start
  });
  const backing = issueAccessCredential({
    subjectId,
    label: "Desktop backing",
    scope: "code",
    expiresAt: new Date("2027-08-20T00:00:00.000Z"),
    allowedPublicModels: ["goldencode"],
    knownPublicModelIds: ["goldencode"],
    now: start
  });
  store.insertAccessCredential({
    ...backing.record,
    tokenCiphertext: encryptSecret(backing.token, recoverySecret)
  });
  const unified = issueUnifiedClientKey({
    subjectId,
    label: "medevidence-internal",
    expiresAt: new Date("2027-08-20T00:00:00.000Z"),
    codexCredentialId: backing.record.id,
    codexCredentialPrefix: backing.record.prefix,
    codexKeyCiphertext: encryptSecret(backing.token, recoverySecret),
    medevidenceKeyCiphertext: encryptSecret("medevidence-key", recoverySecret),
    medevidenceKeyPrefix: "medevidence-prefix",
    metadata: { medevidence_base_url: phoneAuthMedevidenceOrigin },
    now: start
  });
  store.insertUnifiedClientKey(unified.record);

  const { privateKey } = generateKeyPairSync("ed25519");
  let current = start;
  const service = new PhoneAuthService({
    mode: "transition",
    store,
    credentialStore: store,
    unifiedKeyStore: store,
    entitlementStore: store,
    publicGatewayBaseUrl: phoneAuthGatewayOrigin,
    issuer: `${phoneAuthGatewayOrigin}/gateway/auth/v1`,
    audience: "codex-gateway",
    activeKid: "phone-auth-test-key",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    phoneLookupSecret: phoneSecret,
    phoneEncryptionSecret,
    unifiedKeyRecoverySecret: recoverySecret,
    apiKeyEncryptionSecret: recoverySecret,
    now: () => current
  });
  return {
    subjectId,
    store,
    backing,
    unified,
    service,
    setNow: (value: Date) => {
      current = value;
    }
  };
}
