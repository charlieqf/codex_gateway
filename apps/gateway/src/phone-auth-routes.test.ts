import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  encryptSecret,
  issueAccessCredential,
  issueUnifiedClientKey,
  type MessageInput,
  type ProviderAdapter,
  type ProviderHealth,
  type StreamEvent,
  type UpstreamAccount
} from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "./index.js";
import {
  PhoneAuthService,
  phoneAuthGatewayOrigin,
  phoneAuthMedevidenceOrigin
} from "./services/phone-auth-service.js";

const start = new Date("2026-08-20T00:00:00.000Z");
const clientVersion = "1.2.3";
const versionHeader = { "x-medevidence-client-version": clientVersion };
const encryptionSecret = "resolver-encryption-secret-32-characters";
const recoverySecret = "unified-recovery-secret-32-characters-min";
const billingAdminToken = "billing-admin-token-phone-auth-test";
const savedEnvironment = new Map<string, string | undefined>();

for (const name of [
  "GATEWAY_PUBLIC_BASE_URL",
  "GATEWAY_API_KEY_ENCRYPTION_SECRET",
  "GATEWAY_PHONE_AUTH_MODE"
]) {
  savedEnvironment.set(name, process.env[name]);
}

afterEach(() => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("internal phone auth v1 routes", () => {
  it("implements the frozen login, bootstrap, resolve and current contract", async () => {
    const fixture = createFixture();
    try {
      const prepared = await fixture.app.inject({
        method: "POST",
        url: "/gateway/admin/billing/v1/phone-auth-identities",
        headers: { authorization: `Bearer ${billingAdminToken}` },
        payload: {
          phone: "13800138000",
          subject_id: fixture.subjectId,
          unified_key: fixture.unified.token
        }
      });
      expect(prepared.statusCode).toBe(200);
      expect(prepared.json()).toEqual({
        prepared: true,
        subject_id: fixture.subjectId,
        state: "active"
      });
      expect(prepared.body).not.toContain(fixture.unified.token);
      expect(prepared.body).not.toContain("13800138000");

      const upgradeRequired = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/login/start",
        payload: { unexpected: true }
      });
      const upgradeRequestId = upgradeRequired.headers["x-request-id"];
      expect(upgradeRequired.statusCode).toBe(426);
      expect(upgradeRequired.json()).toEqual({
        error: {
          code: "client_upgrade_required",
          message: "A newer MedEvidence Desktop version is required.",
          request_id: upgradeRequestId,
          minimum_version: clientVersion,
          download_url: "https://updates.example/medevidence.exe"
        }
      });
      expect(upgradeRequired.headers["cache-control"]).toBe("no-store");

      const malformedOldClient = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/login/start",
        headers: { "content-type": "application/json" },
        payload: "{"
      });
      expect(malformedOldClient.statusCode).toBe(426);

      const login = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/login/start",
        headers: versionHeader,
        payload: {
          phone: "13800138000",
          client: "medevidence-desktop",
          device_id: "desktop-device-example-01",
          contract_version: 1
        }
      });
      expect(login.statusCode).toBe(200);
      expect(login.headers["cache-control"]).toBe("no-store");
      const loginBody = login.json();
      expect(loginBody).toMatchObject({
        status: "authenticated",
        auth_method: "transition_phone_only",
        expires_in_seconds: 900,
        refresh_idle_expires_in_seconds: 2_592_000,
        subject: { id: fixture.subjectId, state: "active" }
      });

      const authHeaders = {
        ...versionHeader,
        authorization: `Bearer ${loginBody.access_token}`
      };
      const bootstrap = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/session/bootstrap",
        headers: authHeaders,
        payload: {}
      });
      const account = await fixture.app.inject({
        method: "GET",
        url: "/gateway/account/v1/current",
        headers: authHeaders
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(account.statusCode).toBe(200);
      expect(account.json()).toMatchObject({
        subject: { id: fixture.subjectId },
        identity: { kind: "internal", plan_id: "plan_internal" },
        token_wallet: null,
        image_credits: null
      });

      const invalidResolverBearer = await fixture.app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: { authorization: "Bearer invalid" },
        payload: {}
      });
      expect(invalidResolverBearer.statusCode).toBe(401);

      const configuredEncryptionSecret =
        process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
      delete process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
      const resolverUpgrade = await fixture.app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: { authorization: `Bearer ${fixture.unified.token}` },
        payload: {}
      });
      process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET =
        configuredEncryptionSecret;
      expect(resolverUpgrade.statusCode).toBe(426);

      const malformedResolver = await fixture.app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: {
          ...versionHeader,
          authorization: `Bearer ${fixture.unified.token}`,
          "content-type": "application/json"
        },
        payload: "{"
      });
      expect(malformedResolver.statusCode).toBe(400);
      expect(malformedResolver.json().error.code).toBe("invalid_request");
      expect(malformedResolver.headers["cache-control"]).toBe("no-store");

      const resolved = await fixture.app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: {
          ...versionHeader,
          authorization: `Bearer ${fixture.unified.token}`
        },
        payload: {}
      });
      const credentials = await fixture.app.inject({
        method: "GET",
        url: "/gateway/credentials/current",
        headers: {
          ...versionHeader,
          authorization: `Bearer ${fixture.backing.token}`
        }
      });
      expect(resolved.statusCode).toBe(200);
      expect(credentials.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({
        unified_key: {
          prefix: bootstrap.json().unified_key.key_prefix,
          expires_at: bootstrap.json().unified_key.expires_at
        },
        subject: { id: fixture.subjectId },
        codex_gateway: {
          endpoint_base_url: `${phoneAuthGatewayOrigin}/v1`,
          credential_validation_url: `${phoneAuthGatewayOrigin}/gateway/credentials/current`,
          key_prefix: credentials.json().credential.prefix
        }
      });
      expect(credentials.json().entitlement.feature_policy.capabilities).toContain(
        "chat"
      );
      expect(account.json().capabilities).toContain("chat");

      fixture.store.database
        .prepare("UPDATE unified_client_keys SET metadata_json = ? WHERE id = ?")
        .run(
          JSON.stringify({ medevidence_base_url: "https://wrong.example" }),
          fixture.unified.record.id
        );
      const driftedOrigin = await fixture.app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: {
          ...versionHeader,
          authorization: `Bearer ${fixture.unified.token}`
        },
        payload: {}
      });
      expect(driftedOrigin.statusCode).toBe(409);
      expect(driftedOrigin.json().error.code).toBe(
        "account_migration_required"
      );
      fixture.store.database
        .prepare("UPDATE unified_client_keys SET metadata_json = ? WHERE id = ?")
        .run(
          JSON.stringify({
            medevidence_base_url: phoneAuthMedevidenceOrigin
          }),
          fixture.unified.record.id
        );

      const invalidEmptyBody = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/session/bootstrap",
        headers: authHeaders,
        payload: { extra: true }
      });
      expect(invalidEmptyBody.statusCode).toBe(400);
      expect(invalidEmptyBody.json().error).toMatchObject({
        code: "invalid_request",
        request_id: invalidEmptyBody.headers["x-request-id"]
      });

      const malformedJson = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/session/bootstrap",
        headers: {
          ...authHeaders,
          "content-type": "application/json"
        },
        payload: "{"
      });
      expect(malformedJson.statusCode).toBe(400);
      expect(malformedJson.json().error.code).toBe("invalid_request");
      expect(malformedJson.headers["cache-control"]).toBe("no-store");

      const oversizedBody = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/session/bootstrap",
        headers: {
          ...authHeaders,
          "content-type": "application/json"
        },
        payload: JSON.stringify({ value: "x".repeat(256) })
      });
      expect(oversizedBody.statusCode).toBe(400);
      expect(oversizedBody.json().error).toMatchObject({
        code: "invalid_request",
        request_id: oversizedBody.headers["x-request-id"]
      });
      expect(oversizedBody.headers["cache-control"]).toBe("no-store");

      const unsupportedContentType = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/session/bootstrap",
        headers: {
          ...authHeaders,
          "content-type": "application/xml"
        },
        payload: "<empty />"
      });
      expect(unsupportedContentType.statusCode).toBe(400);
      expect(unsupportedContentType.json().error.code).toBe("invalid_request");
      expect(unsupportedContentType.headers["cache-control"]).toBe("no-store");

      const firstLogout = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/logout",
        headers: authHeaders,
        payload: {}
      });
      const secondLogout = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/logout",
        headers: authHeaders
      });
      expect(firstLogout.statusCode).toBe(204);
      expect(secondLogout.statusCode).toBe(204);

      fixture.store.setSubjectState(fixture.subjectId, "disabled");
      const disabledResolver = await fixture.app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: {
          ...versionHeader,
          authorization: `Bearer ${fixture.unified.token}`
        },
        payload: {}
      });
      const disabledCurrent = await fixture.app.inject({
        method: "GET",
        url: "/gateway/credentials/current",
        headers: {
          ...versionHeader,
          authorization: `Bearer ${fixture.backing.token}`
        }
      });
      expect(disabledResolver.statusCode).toBe(403);
      expect(disabledResolver.json().error.code).toBe("account_disabled");
      expect(disabledCurrent.statusCode).toBe(403);
      expect(disabledCurrent.json().error.code).toBe("account_disabled");
      expect(disabledCurrent.headers["cache-control"]).toBe("no-store");
    } finally {
      await fixture.app.close();
    }
  });

  it("gates Desktop business routes but exempts an explicit service credential", async () => {
    const fixture = createFixture();
    try {
      await fixture.app.inject({
        method: "POST",
        url: "/gateway/admin/billing/v1/phone-auth-identities",
        headers: { authorization: `Bearer ${billingAdminToken}` },
        payload: {
          phone: "13800138000",
          subject_id: fixture.subjectId,
          unified_key: fixture.unified.token
        }
      });
      const current = await fixture.app.inject({
        method: "GET",
        url: "/gateway/credentials/current",
        headers: { authorization: `Bearer ${fixture.backing.token}` }
      });
      expect(current.statusCode).toBe(426);
      expect(current.headers["cache-control"]).toBe("no-store");

      const vision = await fixture.app.inject({
        method: "POST",
        url: "/gateway/vision/assets",
        headers: { authorization: `Bearer ${fixture.backing.token}` },
        payload: {}
      });
      expect(vision.statusCode).toBe(426);

      const serviceCredential = issueAccessCredential({
        subjectId: fixture.subjectId,
        label: "Internal service",
        scope: "code",
        expiresAt: new Date("2027-08-20T00:00:00.000Z"),
        credentialClass: "service",
        now: start
      });
      fixture.store.insertAccessCredential(serviceCredential.record);
      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${serviceCredential.token}` }
      });
      expect(models.statusCode).toBe(200);
    } finally {
      await fixture.app.close();
    }
  });

  it("rate limits login by phone hash without auditing the raw phone", async () => {
    const fixture = createFixture({ phoneRequestsPerMinute: 1 });
    try {
      await fixture.app.inject({
        method: "POST",
        url: "/gateway/admin/billing/v1/phone-auth-identities",
        headers: { authorization: `Bearer ${billingAdminToken}` },
        payload: {
          phone: "13800138000",
          subject_id: fixture.subjectId,
          unified_key: fixture.unified.token
        }
      });
      const request = () =>
        fixture.app.inject({
          method: "POST",
          url: "/gateway/auth/v1/login/start",
          headers: versionHeader,
          payload: {
            phone: "13800138000",
            client: "medevidence-desktop",
            device_id: "desktop-device-example-01",
            contract_version: 1
          }
        });
      expect((await request()).statusCode).toBe(200);
      const limited = await request();
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toMatchObject({
        code: "auth_rate_limited",
        request_id: limited.headers["x-request-id"]
      });
      const audit = JSON.stringify(
        fixture.store.database
          .prepare(
            "SELECT phone_hash, reason_code FROM phone_auth_audit_events WHERE reason_code = 'auth_rate_limited'"
          )
          .all()
      );
      expect(audit).toContain("hmac-sha256:");
      expect(audit).not.toContain("13800138000");
    } finally {
      await fixture.app.close();
    }
  });

  it("rate limits the client IP supplied by the trusted R760 proxy", async () => {
    const fixture = createFixture({ ipRequestsPerMinute: 1 });
    try {
      await fixture.app.inject({
        method: "POST",
        url: "/gateway/admin/billing/v1/phone-auth-identities",
        headers: { authorization: `Bearer ${billingAdminToken}` },
        payload: {
          phone: "13800138000",
          subject_id: fixture.subjectId,
          unified_key: fixture.unified.token
        }
      });
      const request = (forwardedFor: string) =>
        fixture.app.inject({
          method: "POST",
          url: "/gateway/auth/v1/login/start",
          headers: { ...versionHeader, "x-forwarded-for": forwardedFor },
          payload: {
            phone: "13800138000",
            client: "medevidence-desktop",
            device_id: "desktop-device-example-01",
            contract_version: 1
          }
        });

      expect((await request("203.0.113.10")).statusCode).toBe(200);
      expect((await request("203.0.113.11")).statusCode).toBe(200);
      expect((await request("203.0.113.11")).statusCode).toBe(429);
    } finally {
      await fixture.app.close();
    }
  });

  it("refuses transition mode when the injected service is absent", () => {
    process.env.GATEWAY_PHONE_AUTH_MODE = "transition";
    process.env.GATEWAY_PUBLIC_BASE_URL = phoneAuthGatewayOrigin;
    const store = createSqliteStore({ path: ":memory:" });
    try {
      expect(() =>
        buildGateway({
          authMode: "credential",
          provider: new FakeProvider(),
          sessionStore: store,
          phoneAuthService: null,
          desktopVersionGate: {
            enabled: true,
            minimumVersion: clientVersion,
            downloadUrl: "https://updates.example/medevidence.exe"
          },
          logger: false
        })
      ).toThrow("requires an enabled PhoneAuthService");
    } finally {
      store.close();
    }
  });
});

class FakeProvider implements ProviderAdapter {
  readonly kind = "fake";

  async health(_upstreamAccount: UpstreamAccount): Promise<ProviderHealth> {
    return { state: "healthy", checkedAt: start };
  }

  async *message(_input: MessageInput): AsyncIterable<StreamEvent> {
    yield { type: "message_delta", text: "ok" };
    yield { type: "completed", providerSessionRef: "provider-session" };
  }
}

function createFixture(
  options: {
    phoneRequestsPerMinute?: number;
    ipRequestsPerMinute?: number;
  } = {}
) {
  process.env.GATEWAY_PUBLIC_BASE_URL = phoneAuthGatewayOrigin;
  process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET = encryptionSecret;
  process.env.GATEWAY_PHONE_AUTH_MODE = "disabled";
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
  store.insertAccessCredential(backing.record);
  const unified = issueUnifiedClientKey({
    subjectId,
    label: "medevidence-internal",
    expiresAt: new Date("2027-08-20T00:00:00.000Z"),
    codexCredentialId: backing.record.id,
    codexCredentialPrefix: backing.record.prefix,
    codexKeyCiphertext: encryptSecret(backing.token, encryptionSecret),
    medevidenceKeyCiphertext: encryptSecret(
      "medevidence-runtime-key",
      encryptionSecret
    ),
    medevidenceKeyPrefix: "medevidence-prefix",
    metadata: { medevidence_base_url: phoneAuthMedevidenceOrigin },
    now: start
  });
  store.insertUnifiedClientKey(unified.record);
  const { privateKey } = generateKeyPairSync("ed25519");
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
    phoneLookupSecret: "phone-lookup-secret-32-characters-minimum",
    phoneEncryptionSecret: "phone-encryption-secret-32-characters-min",
    unifiedKeyRecoverySecret: recoverySecret,
    apiKeyEncryptionSecret: encryptionSecret,
    now: () => start
  });
  const app = buildGateway({
    authMode: "credential",
    provider: new FakeProvider(),
    sessionStore: store,
    phoneAuthService: service,
    desktopVersionGate: {
      enabled: true,
      minimumVersion: clientVersion,
      downloadUrl: "https://updates.example/medevidence.exe"
    },
    billingAdminToken,
    billingAdminTokenMode: "env",
    phoneAuthPhoneRequestsPerMinute: options.phoneRequestsPerMinute,
    phoneAuthIpRequestsPerMinute: options.ipRequestsPerMinute,
    now: () => start,
    logger: false
  });
  return { app, store, subjectId, backing, unified };
}
