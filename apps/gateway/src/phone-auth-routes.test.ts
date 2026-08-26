import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultImageGenerationFeaturePolicy,
  encryptSecret,
  issueAccessCredential,
  issueUnifiedClientKey,
  type MessageInput,
  type ProviderAdapter,
  type ProviderHealth,
  type StreamEvent,
  type UpstreamAccount
} from "@codex-gateway/core";
import {
  createResearchSqliteStore,
  createSqliteStore
} from "@codex-gateway/store-sqlite";
import type { ImageGenerationProvider } from "./image-generation.js";
import { buildGateway } from "./index.js";
import {
  phoneAuthLegacyMedevidenceOrigin,
  phoneAuthR760MedevidenceOrigin
} from "./medevidence-origin-policy.js";
import {
  PhoneAuthService,
  phoneAuthGatewayOrigin,
  phoneAuthMedevidenceOrigin
} from "./services/phone-auth-service.js";
import { InMemoryCredentialRateLimiter } from "./services/rate-limiter.js";
import type {
  VisionAssetReadGrant,
  VisionAssetService,
  VisionAssetUploadGrant
} from "./services/vision-asset-service.js";

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
  "GATEWAY_PHONE_AUTH_MODE",
  "GATEWAY_DESKTOP_VERSION_GATE",
  "GATEWAY_MINIMUM_DESKTOP_VERSION",
  "GATEWAY_DESKTOP_DOWNLOAD_URL",
  "GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION"
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
  it("keeps legacy clients on nip.io and routes only fixed clients to R760", async () => {
    const fixture = createFixture({
      medevidenceR760MinimumDesktopVersion: "2.0.0-beta.47"
    });
    try {
      const health = await fixture.app.inject({
        method: "GET",
        url: "/gateway/health"
      });
      expect(health.json().medevidence_routing).toEqual({
        mode: "versioned",
        r760_minimum_desktop_version: "2.0.0-beta.47"
      });

      const resolve = (version?: string) =>
        fixture.app.inject({
          method: "POST",
          url: "/gateway/unified-keys/resolve",
          headers: {
            authorization: `Bearer ${fixture.unified.token}`,
            ...(version
              ? { "x-medevidence-client-version": version }
              : {})
          },
          payload: {}
        });

      const missingVersion = await resolve();
      const lowerVersion = await resolve("2.0.0-beta.46");
      const malformedVersion = await resolve("beta.47");
      const fixedVersion = await resolve("2.0.0-beta.47");

      expect(missingVersion.statusCode).toBe(200);
      expect(lowerVersion.statusCode).toBe(200);
      expect(malformedVersion.statusCode).toBe(200);
      expect(fixedVersion.statusCode).toBe(200);
      expect(missingVersion.json().medevidence.base_url).toBe(
        phoneAuthLegacyMedevidenceOrigin
      );
      expect(lowerVersion.json().medevidence.base_url).toBe(
        phoneAuthLegacyMedevidenceOrigin
      );
      expect(malformedVersion.json().medevidence.base_url).toBe(
        phoneAuthLegacyMedevidenceOrigin
      );
      expect(fixedVersion.json().medevidence.base_url).toBe(
        phoneAuthR760MedevidenceOrigin
      );
      expect(
        fixture.store.getUnifiedClientKeyByPrefix(
          fixture.unified.record.prefix
        )?.metadata
      ).toEqual({
        medevidence_base_url: phoneAuthLegacyMedevidenceOrigin
      });

      fixture.store.database
        .prepare("UPDATE unified_client_keys SET metadata_json = ? WHERE id = ?")
        .run(
          JSON.stringify({
            medevidence_base_url: phoneAuthR760MedevidenceOrigin
          }),
          fixture.unified.record.id
        );
      expect((await resolve()).json().medevidence.base_url).toBe(
        phoneAuthLegacyMedevidenceOrigin
      );
      expect((await resolve("2.0.0-beta.47")).json().medevidence.base_url).toBe(
        phoneAuthR760MedevidenceOrigin
      );

      fixture.store.database
        .prepare("UPDATE unified_client_keys SET metadata_json = NULL WHERE id = ?")
        .run(fixture.unified.record.id);
      const missingMetadataWithoutVersion = await resolve();
      const missingMetadataLowerVersion = await resolve("2.0.0-beta.46");
      const missingMetadataMalformedVersion = await resolve("not-semver");
      const missingMetadataFixedVersion = await resolve("2.0.0-beta.47");

      expect(missingMetadataWithoutVersion.statusCode).toBe(200);
      expect(missingMetadataLowerVersion.statusCode).toBe(200);
      expect(missingMetadataMalformedVersion.statusCode).toBe(200);
      expect(missingMetadataFixedVersion.statusCode).toBe(200);
      expect(missingMetadataWithoutVersion.json().medevidence.base_url).toBe(
        phoneAuthLegacyMedevidenceOrigin
      );
      expect(missingMetadataLowerVersion.json().medevidence.base_url).toBe(
        phoneAuthLegacyMedevidenceOrigin
      );
      expect(missingMetadataMalformedVersion.json().medevidence.base_url).toBe(
        phoneAuthLegacyMedevidenceOrigin
      );
      expect(missingMetadataFixedVersion.json().medevidence.base_url).toBe(
        phoneAuthR760MedevidenceOrigin
      );
      expect(
        fixture.store.getUnifiedClientKeyByPrefix(
          fixture.unified.record.prefix
        )?.metadata
      ).toBeNull();
    } finally {
      await fixture.app.close();
    }
  });

  it("implements the frozen login, bootstrap, resolve and current contract", async () => {
    const fixture = createFixture();
    try {
      const health = await fixture.app.inject({
        method: "GET",
        url: "/gateway/health"
      });
      expect(health.statusCode).toBe(200);
      expect(health.json().phone_auth).toEqual({
        mode: "transition",
        version_gate_mode: "auth_only",
        minimum_desktop_version: clientVersion
      });
      expect(JSON.stringify(health.json().phone_auth)).not.toMatch(
        /phone|allowlist|session|secret|key_prefix/iu
      );

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

      const lowVersion = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/login/start",
        headers: { "x-medevidence-client-version": "1.2.2" },
        payload: { unexpected: true }
      });
      expect(lowVersion.statusCode).toBe(426);
      expect(lowVersion.json().error.code).toBe("client_upgrade_required");

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

      const refresh = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/token/refresh",
        headers: versionHeader,
        payload: {
          refresh_token: loginBody.refresh_token,
          client: "medevidence-desktop",
          device_id: "desktop-device-example-01",
          contract_version: 1
        }
      });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json().refresh_token).not.toBe(loginBody.refresh_token);
      const replay = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/token/refresh",
        headers: versionHeader,
        payload: {
          refresh_token: loginBody.refresh_token,
          client: "medevidence-desktop",
          device_id: "desktop-device-example-01",
          contract_version: 1
        }
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe("refresh_token_invalid");
      const replayedSession = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/session/bootstrap",
        headers: {
          ...versionHeader,
          authorization: `Bearer ${refresh.json().access_token}`
        },
        payload: {}
      });
      expect(replayedSession.statusCode).toBe(401);
      expect(replayedSession.json().error.code).toBe("access_token_invalid");

      const replacementLogin = await fixture.app.inject({
        method: "POST",
        url: "/gateway/auth/v1/login/start",
        headers: versionHeader,
        payload: {
          phone: "13800138000",
          client: "medevidence-desktop",
          device_id: "desktop-device-example-02",
          contract_version: 1
        }
      });
      expect(replacementLogin.statusCode).toBe(200);
      const replacementLoginBody = replacementLogin.json();

      const authHeaders = {
        ...versionHeader,
        authorization: `Bearer ${replacementLoginBody.access_token}`
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
      expect(resolverUpgrade.statusCode).toBe(503);
      expect(resolverUpgrade.json().error.code).toBe("service_unavailable");

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
      expect(
        resolved.json().codex_gateway.api_key.startsWith(
          `${resolved.json().codex_gateway.key_prefix}.`
        )
      ).toBe(true);
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

  it("leaves legacy and business routes outside the auth_only gate", async () => {
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
      expect(current.statusCode).toBe(200);

      const vision = await fixture.app.inject({
        method: "POST",
        url: "/gateway/vision/assets",
        headers: { authorization: `Bearer ${fixture.backing.token}` },
        payload: {}
      });
      expect(vision.statusCode).not.toBe(426);

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

  it("keeps beta.38 no-version-header resolver, chat/tools, Research, image, and Vision outside the version gate", async () => {
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
      fixture.store.database
        .prepare(
          "UPDATE access_credentials SET allowed_public_models_json = NULL WHERE id = ?"
        )
        .run(fixture.backing.record.id);

      const resolver = await fixture.app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: { authorization: `Bearer ${fixture.unified.token}` },
        payload: {}
      });
      const current = await fixture.app.inject({
        method: "GET",
        url: "/gateway/credentials/current",
        headers: { authorization: `Bearer ${fixture.backing.token}` }
      });
      const chat = await fixture.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${fixture.backing.token}` },
        payload: {
          model: "medcode",
          messages: [{ role: "user", content: "compatibility check" }]
        }
      });
      const tools = await fixture.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${fixture.backing.token}` },
        payload: {
          model: "medcode",
          messages: [{ role: "user", content: "tool compatibility check" }],
          tools: [
            {
              type: "function",
              function: {
                name: "compatibility_probe",
                description: "Return compatibility status.",
                parameters: {
                  type: "object",
                  properties: {},
                  additionalProperties: false
                }
              }
            }
          ]
        }
      });
      const research = await fixture.app.inject({
        method: "POST",
        url: "/gateway/research/v1/doctor-runs",
        headers: {
          authorization: `Bearer ${fixture.backing.token}`,
          "idempotency-key": "research:beta38-no-header"
        },
        payload: {
          doctor: {
            name: "Compatibility Doctor",
            hospital: "Example Hospital",
            department: "Cardiology",
            title: null,
            city: "Sydney",
            orcid: null
          },
          mode: "brief",
          language: "en",
          options: {
            publication_years: 5,
            citation_style: "vancouver"
          },
          client_reference: "beta38-compatibility"
        }
      });
      const image = await fixture.app.inject({
        method: "POST",
        url: "/gateway/images/generations",
        headers: { authorization: `Bearer ${fixture.backing.token}` },
        payload: {
          model: "medcode-image-default",
          prompt: "Create a compatibility diagram.",
          size: "1024x1024"
        }
      });
      const createVision = await fixture.app.inject({
        method: "POST",
        url: "/gateway/vision/assets",
        headers: { authorization: `Bearer ${fixture.backing.token}` },
        payload: {
          content_type: "image/png",
          size_bytes: 68,
          sha256: "a".repeat(64)
        }
      });
      const assetId = "va1.compatibility.signature";
      const completeVision = await fixture.app.inject({
        method: "POST",
        url: `/gateway/vision/assets/${assetId}/complete`,
        headers: { authorization: `Bearer ${fixture.backing.token}` }
      });
      const readVision = await fixture.app.inject({
        method: "POST",
        url: `/gateway/vision/assets/${assetId}/read-url`,
        headers: { authorization: `Bearer ${fixture.backing.token}` },
        payload: {}
      });
      const deleteVision = await fixture.app.inject({
        method: "DELETE",
        url: `/gateway/vision/assets/${assetId}`,
        headers: { authorization: `Bearer ${fixture.backing.token}` }
      });

      expect(research.statusCode, research.body).toBe(202);

      expect({
        resolver: resolver.statusCode,
        current: current.statusCode,
        chat: chat.statusCode,
        tools: tools.statusCode,
        research: research.statusCode,
        image: image.statusCode,
        visionCreate: createVision.statusCode,
        visionComplete: completeVision.statusCode,
        visionRead: readVision.statusCode,
        visionDelete: deleteVision.statusCode
      }).toEqual({
        resolver: 200,
        current: 200,
        chat: 200,
        tools: 200,
        research: 202,
        image: 200,
        visionCreate: 403,
        visionComplete: 403,
        visionRead: 403,
        visionDelete: 403
      });
      for (const response of [
        createVision,
        completeVision,
        readVision,
        deleteVision
      ]) {
        expect(response.json().error.code).toBe(
          "model_not_allowed_for_credential"
        );
      }
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

  it("rate limits by a SHA-256 device bucket without retaining raw risk identifiers", async () => {
    const fixture = createFixture({ deviceRequestsPerMinute: 1 });
    const rawDeviceId = "desktop-device-sensitive-01";
    const rawIp = "203.0.113.25";
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
          headers: { ...versionHeader, "x-forwarded-for": rawIp },
          payload: {
            phone: "13800138000",
            client: "medevidence-desktop",
            device_id: rawDeviceId,
            contract_version: 1
          }
        });

      expect((await request()).statusCode).toBe(200);
      const limited = await request();
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("auth_rate_limited");

      const limiterKeys = Array.from(
        (
          fixture.loginRateLimiter as unknown as {
            states: Map<string, unknown>;
          }
        ).states.keys()
      );
      expect(limiterKeys).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^phone-auth:phone:hmac-sha256:/u),
          expect.stringMatching(/^phone-auth:ip:[A-Za-z0-9_-]{43}$/u),
          expect.stringMatching(/^phone-auth:device:[A-Za-z0-9_-]{43}$/u)
        ])
      );
      const serializedKeys = JSON.stringify(limiterKeys);
      expect(serializedKeys).not.toContain("13800138000");
      expect(serializedKeys).not.toContain(rawIp);
      expect(serializedKeys).not.toContain(rawDeviceId);
    } finally {
      await fixture.app.close();
    }
  });

  it("returns phone_login_disabled only for identity disable and preserves the legacy Key path", async () => {
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
      const before = legacyKeySnapshot(fixture);
      const disable = await fixture.app.inject({
        method: "PATCH",
        url: `/gateway/admin/billing/v1/phone-auth-identities/${fixture.subjectId}`,
        headers: { authorization: `Bearer ${billingAdminToken}` },
        payload: { state: "disabled" }
      });
      expect(disable.statusCode).toBe(200);

      const login = () =>
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
      const phoneDisabled = await login();
      expect(phoneDisabled.statusCode).toBe(403);
      expect(phoneDisabled.json().error.code).toBe("phone_login_disabled");
      expect(legacyKeySnapshot(fixture)).toEqual(before);

      const resolver = await fixture.app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: { authorization: `Bearer ${fixture.unified.token}` },
        payload: {}
      });
      expect(resolver.statusCode).toBe(200);
      expect(legacyKeySnapshot(fixture)).toEqual(before);

      await fixture.app.inject({
        method: "PATCH",
        url: `/gateway/admin/billing/v1/phone-auth-identities/${fixture.subjectId}`,
        headers: { authorization: `Bearer ${billingAdminToken}` },
        payload: { state: "active" }
      });
      fixture.store.setSubjectState(fixture.subjectId, "disabled");
      const accountDisabled = await login();
      expect(accountDisabled.statusCode).toBe(403);
      expect(accountDisabled.json().error.code).toBe("account_disabled");
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
            mode: "auth_only",
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

  it("enforces the disabled/auth_only/all and transition startup matrices before listen", async () => {
    const fixture = createFixture();
    const createdApps: ReturnType<typeof buildGateway>[] = [];
    const gateFor = (mode: "disabled" | "auth_only" | "all") => ({
      mode,
      minimumVersion: mode === "disabled" ? null : clientVersion,
      downloadUrl:
        mode === "disabled" ? null : "https://updates.example/medevidence.exe"
    });
    try {
      process.env.GATEWAY_PHONE_AUTH_MODE = "disabled";
      for (const mode of ["disabled", "auth_only", "all"] as const) {
        const matrixStore = createSqliteStore({ path: ":memory:" });
        createdApps.push(
          buildGateway({
            authMode: "credential",
            provider: new FakeProvider(),
            sessionStore: matrixStore,
            phoneAuthService: null,
            desktopVersionGate: gateFor(mode),
            logger: false
          })
        );
      }

      process.env.GATEWAY_PHONE_AUTH_MODE = "transition";
      for (const mode of ["disabled", "all"] as const) {
        expect(() =>
          buildGateway({
            authMode: "credential",
            provider: new FakeProvider(),
            sessionStore: fixture.store,
            phoneAuthService: fixture.service,
            desktopVersionGate: gateFor(mode),
            logger: false
          })
        ).toThrow("GATEWAY_DESKTOP_VERSION_GATE=auth_only");
      }
      expect(fixture.app.server.listening).toBe(false);

      process.env.GATEWAY_DESKTOP_VERSION_GATE = "enabled";
      expect(() =>
        buildGateway({
          authMode: "credential",
          provider: new FakeProvider(),
          sessionStore: fixture.store,
          phoneAuthService: fixture.service,
          logger: false
        })
      ).toThrow("legacy enabled value is invalid");
      for (const app of createdApps) {
        expect(app.server.listening).toBe(false);
      }
    } finally {
      await Promise.all(createdApps.map((app) => app.close()));
      await fixture.app.close();
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
    deviceRequestsPerMinute?: number;
    medevidenceR760MinimumDesktopVersion?: string | null;
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
      capabilities: [
        "chat",
        "tools",
        "doctor_research",
        "image_generation"
      ],
      imageGeneration: defaultImageGenerationFeaturePolicy(),
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
  const loginRateLimiter = new InMemoryCredentialRateLimiter({ now: () => start });
  const researchStore = createResearchSqliteStore({
    path: ":memory:",
    limits: {
      dailyRunsPerSubject: 10,
      uniqueDoctors30dPerSubject: 10,
      globalActiveRuns: 100,
      needsInputPerSubject: 10
    }
  });
  const app = buildGateway({
    authMode: "credential",
    provider: new FakeProvider(),
    sessionStore: store,
    phoneAuthService: service,
    desktopVersionGate: {
      mode: "auth_only",
      minimumVersion: clientVersion,
      downloadUrl: "https://updates.example/medevidence.exe"
    },
    medevidenceOriginPolicy: options.medevidenceR760MinimumDesktopVersion
      ? {
          mode: "versioned",
          r760MinimumDesktopVersion:
            options.medevidenceR760MinimumDesktopVersion
        }
      : {
          mode: "legacy_only",
          r760MinimumDesktopVersion: null
        },
    billingAdminToken,
    billingAdminTokenMode: "env",
    phoneAuthLoginRateLimiter: loginRateLimiter,
    phoneAuthPhoneRequestsPerMinute: options.phoneRequestsPerMinute,
    phoneAuthIpRequestsPerMinute: options.ipRequestsPerMinute,
    phoneAuthDeviceRequestsPerMinute: options.deviceRequestsPerMinute,
    researchStore,
    researchAcceptWhenWorkerUnavailable: true,
    imageGenerationProvider: new CompatibilityImageProvider(),
    visionAssetService: new CompatibilityVisionAssetService(),
    now: () => start,
    logger: false
  });
  return {
    app,
    store,
    researchStore,
    subjectId,
    backing,
    unified,
    service,
    loginRateLimiter
  };
}

function legacyKeySnapshot(fixture: ReturnType<typeof createFixture>) {
  const backing = fixture.store.getAccessCredentialByPrefix(
    fixture.backing.record.prefix
  );
  const unified = fixture.store.getUnifiedClientKeyByPrefix(
    fixture.unified.record.prefix
  );
  return {
    subjectState: fixture.store.getSubject(fixture.subjectId)?.state,
    backing: backing && {
      id: backing.id,
      expiresAt: backing.expiresAt.toISOString(),
      revokedAt: backing.revokedAt?.toISOString() ?? null,
      credentialClass: backing.credentialClass,
      allowedPublicModels: backing.allowedPublicModels
    },
    unified: unified && {
      id: unified.id,
      expiresAt: unified.expiresAt.toISOString(),
      revokedAt: unified.revokedAt?.toISOString() ?? null,
      credentialClass: unified.credentialClass,
      isCurrent: unified.isCurrent
    }
  };
}

class CompatibilityImageProvider implements ImageGenerationProvider {
  readonly providerKind = "openai-api" as const;

  async generate() {
    return {
      created: 1_776_123_456,
      data: [{ b64_json: "ZmFrZS1pbWFnZQ==" }]
    };
  }
}

class CompatibilityVisionAssetService implements VisionAssetService {
  createAsset(): VisionAssetUploadGrant {
    return {
      assetId: "va1.compatibility.signature",
      contentType: "image/png",
      sizeBytes: 68,
      sha256: "a".repeat(64),
      uploadUrl: "https://assets.example/upload",
      uploadHeaders: {
        "Content-Type": "image/png",
        "If-None-Match": "*"
      },
      uploadExpiresAt: new Date("2026-08-20T00:10:00.000Z"),
      assetExpiresAt: new Date("2026-08-21T00:00:00.000Z")
    };
  }

  async completeAsset(): Promise<VisionAssetReadGrant> {
    return this.readGrant();
  }

  async createReadUrl(): Promise<VisionAssetReadGrant> {
    return this.readGrant();
  }

  async deleteAsset(): Promise<void> {}

  private readGrant(): VisionAssetReadGrant {
    return {
      assetId: "va1.compatibility.signature",
      contentType: "image/png",
      sizeBytes: 68,
      sha256: "a".repeat(64),
      imageUrl: "https://assets.example/read",
      readUrlExpiresAt: new Date("2026-08-20T00:30:00.000Z"),
      assetExpiresAt: new Date("2026-08-21T00:00:00.000Z")
    };
  }
}
