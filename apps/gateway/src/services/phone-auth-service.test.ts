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
  phoneAuthMedevidenceOrigin,
  phoneAuthR760MedevidenceOrigin
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
    const accessPayload = JSON.parse(
      Buffer.from(login.access_token.split(".")[1]!, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    expect(accessPayload.nbf).toBe(accessPayload.iat);

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
    const auditText = JSON.stringify(
      fixture.store.database
        .prepare("SELECT * FROM phone_auth_audit_events ORDER BY created_at")
        .all()
    );
    expect(
      [
        "13800138000",
        "desktop-device-example-01",
        fixture.unified.token,
        login.access_token,
        login.refresh_token
      ].some((sensitiveValue) => auditText.includes(sensitiveValue))
    ).toBe(false);
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

  it("keeps the legacy Key, Plan, entitlement, capabilities, and usage invariant across Phone Session lifecycle actions", () => {
    const fixture = createFixture();
    fixture.service.prepareIdentity({
      phone: "13800138000",
      subjectId: fixture.subjectId,
      unifiedKey: fixture.unified.token,
      requestId: "req_prepare"
    });
    const before = accountInvariantSnapshot(fixture.store.database);

    const replayLogin = fixture.service.login({
      phone: "13800138000",
      deviceId: "desktop-device-example-01",
      requestId: "req_replay_login"
    });
    const refreshed = fixture.service.refresh({
      refreshToken: replayLogin.refresh_token,
      deviceId: "desktop-device-example-01",
      requestId: "req_refresh"
    });
    expect(() =>
      fixture.service.refresh({
        refreshToken: replayLogin.refresh_token,
        deviceId: "desktop-device-example-01",
        requestId: "req_replay"
      })
    ).toThrowError(expect.objectContaining({ code: "refresh_token_invalid" }));
    expect(() =>
      fixture.service.bootstrap(refreshed.access_token, "req_replayed_session")
    ).toThrowError(expect.objectContaining({ code: "access_token_invalid" }));
    expect(accountInvariantSnapshot(fixture.store.database)).toEqual(before);

    const logoutLogin = fixture.service.login({
      phone: "13800138000",
      deviceId: "desktop-device-example-02",
      requestId: "req_logout_login"
    });
    fixture.service.logout(logoutLogin.access_token, "req_logout");
    expect(accountInvariantSnapshot(fixture.store.database)).toEqual(before);

    const disabledLogin = fixture.service.login({
      phone: "13800138000",
      deviceId: "desktop-device-example-03",
      requestId: "req_disable_login"
    });
    fixture.service.setIdentityState(fixture.subjectId, "disabled", "req_disable");
    expect(() =>
      fixture.service.bootstrap(disabledLogin.access_token, "req_disabled_session")
    ).toThrowError(expect.objectContaining({ code: "access_token_invalid" }));
    expect(() =>
      fixture.service.login({
        phone: "13800138000",
        deviceId: "desktop-device-example-04",
        requestId: "req_disabled_login"
      })
    ).toThrowError(expect.objectContaining({ code: "phone_login_disabled" }));
    expect(accountInvariantSnapshot(fixture.store.database)).toEqual(before);
    fixture.store.close();
  });

  it("distinguishes a disabled Phone identity from a disabled Subject", () => {
    const phoneDisabled = createFixture();
    phoneDisabled.service.prepareIdentity({
      phone: "13800138000",
      subjectId: phoneDisabled.subjectId,
      unifiedKey: phoneDisabled.unified.token,
      requestId: "req_prepare"
    });
    phoneDisabled.service.setIdentityState(
      phoneDisabled.subjectId,
      "disabled",
      "req_disable_phone"
    );
    expect(() =>
      phoneDisabled.service.login({
        phone: "13800138000",
        deviceId: "desktop-device-example-01",
        requestId: "req_phone_disabled"
      })
    ).toThrowError(
      expect.objectContaining({ code: "phone_login_disabled", httpStatus: 403 })
    );
    phoneDisabled.store.close();

    const accountDisabled = createFixture();
    accountDisabled.service.prepareIdentity({
      phone: "13800138000",
      subjectId: accountDisabled.subjectId,
      unifiedKey: accountDisabled.unified.token,
      requestId: "req_prepare"
    });
    accountDisabled.store.setSubjectState(
      accountDisabled.subjectId,
      "disabled"
    );
    expect(() =>
      accountDisabled.service.login({
        phone: "13800138000",
        deviceId: "desktop-device-example-01",
        requestId: "req_account_disabled"
      })
    ).toThrowError(
      expect.objectContaining({ code: "account_disabled", httpStatus: 403 })
    );
    accountDisabled.store.close();
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

  it("accepts both approved MedEvidence origins and rejects all others", () => {
    const migrated = createFixture();
    migrated.store.database
      .prepare("UPDATE unified_client_keys SET metadata_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          medevidence_base_url: phoneAuthR760MedevidenceOrigin
        }),
        migrated.unified.record.id
      );
    migrated.service.prepareIdentity({
      phone: "13800138000",
      subjectId: migrated.subjectId,
      unifiedKey: migrated.unified.token,
      requestId: "req_r760_origin"
    });
    expect(
      migrated.store.getUnifiedClientKeyByPrefix(migrated.unified.record.prefix)
        ?.metadata
    ).toEqual({ medevidence_base_url: phoneAuthR760MedevidenceOrigin });
    migrated.store.close();

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
    ).toEqual(["goldencode", "goldencode-local"]);
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

function accountInvariantSnapshot(database: {
  prepare(sql: string): { all(): unknown[] };
}) {
  const rows = (sql: string) => database.prepare(sql).all();
  return {
    subjects: rows(
      "SELECT id, label, phone_number, state, created_at FROM subjects ORDER BY id"
    ),
    credentials: rows(
      "SELECT id, subject_id, scope, expires_at, revoked_at, rate_json, allowed_public_models_json, credential_class FROM access_credentials ORDER BY id"
    ),
    unifiedKeys: rows(
      "SELECT id, subject_id, expires_at, revoked_at, codex_credential_id, metadata_json, credential_class, is_current FROM unified_client_keys ORDER BY id"
    ),
    plans: rows(
      "SELECT id, policy_json, feature_policy_json, scope_allowlist_json, priority_class, team_pool_id, state FROM plans ORDER BY id"
    ),
    entitlements: rows(
      "SELECT id, subject_id, plan_id, policy_snapshot_json, scope_allowlist_json, period_kind, period_start, period_end, state FROM entitlements ORDER BY id"
    ),
    tokenWindows: rows(
      "SELECT subject_id, window_kind, window_start, prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens, estimated_tokens, requests FROM token_windows ORDER BY subject_id, window_kind, window_start"
    ),
    entitlementTokenWindows: rows(
      "SELECT entitlement_id, window_kind, window_start, prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens, estimated_tokens, requests FROM entitlement_token_windows ORDER BY entitlement_id, window_kind, window_start"
    ),
    tokenReservations: rows(
      "SELECT id, request_id, credential_id, subject_id, entitlement_id, finalized_at, final_total_tokens FROM token_reservations ORDER BY id"
    ),
    requestEvents: rows(
      "SELECT request_id, credential_id, subject_id, status, error_code FROM request_events ORDER BY request_id"
    )
  };
}
