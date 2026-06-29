import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultImageGenerationFeaturePolicy,
  encryptSecret,
  GatewayError,
  issueAccessCredential,
  issueBillingAdminToken,
  issueUnifiedClientKey,
  validateFeaturePolicy,
  type MessageInput,
  type ProviderAdapter,
  type ProviderHealth,
  type RateLimitPolicy,
  type StreamEvent,
  type UpstreamAccount
} from "@codex-gateway/core";
import {
  createSqliteClientEventsStore,
  createSqliteTokenBudgetLimiter,
  createSqliteStore
} from "@codex-gateway/store-sqlite";
import type { ImageGenerationProvider } from "./image-generation.js";
import { buildGateway, validateRuntimeEnvironment } from "./index.js";
import { InMemoryCredentialRateLimiter } from "./services/rate-limiter.js";
import type {
  UpstreamV2Client,
  UpstreamV2CreateUserInput
} from "./upstream-v2-client.js";

class FakeProvider implements ProviderAdapter {
  readonly kind = "fake";
  readonly messages: MessageInput[] = [];

  constructor(private readonly events?: StreamEvent[]) {}

  async health(_upstreamAccount: UpstreamAccount): Promise<ProviderHealth> {
    return {
      state: "healthy",
      checkedAt: new Date("2026-01-01T00:00:00Z")
    };
  }

  async *message(input: MessageInput): AsyncIterable<StreamEvent> {
    this.messages.push(input);
    if (this.events) {
      for (const event of this.events) {
        yield event;
      }
      return;
    }

    yield { type: "message_delta", text: `echo:${input.message}` };
    yield { type: "completed", providerSessionRef: "provider_thread_1" };
  }
}

class FakeImageGenerationProvider implements ImageGenerationProvider {
  readonly calls: Array<Parameters<ImageGenerationProvider["generate"]>[0]> = [];

  constructor(private readonly resultOrError?: Awaited<ReturnType<ImageGenerationProvider["generate"]>> | GatewayError) {}

  async generate(input: Parameters<ImageGenerationProvider["generate"]>[0]) {
    this.calls.push(input);
    if (this.resultOrError instanceof GatewayError) {
      throw this.resultOrError;
    }
    if (this.resultOrError) {
      return this.resultOrError;
    }
    return {
      created: 1778123456,
      data: [
        {
          b64_json: "ZmFrZS1pbWFnZQ=="
        }
      ],
      usage: {
        total_tokens: 12,
        input_tokens: 5,
        output_tokens: 7
      }
    };
  }
}

class HangingImageGenerationProvider implements ImageGenerationProvider {
  readonly calls: Array<Parameters<ImageGenerationProvider["generate"]>[0]> = [];
  readonly started: Promise<void>;
  private resolveStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  async generate(input: Parameters<ImageGenerationProvider["generate"]>[0]) {
    this.calls.push(input);
    this.resolveStarted();
    return new Promise<never>((_resolve, reject) => {
      const rejectForAbort = () => {
        const clientAborted =
          input.signal?.reason instanceof Error && input.signal.reason.message === "client_aborted";
        reject(
          new GatewayError({
            code: clientAborted ? "client_aborted" : "upstream_timeout",
            message: clientAborted
              ? "Client aborted image generation."
              : "Image generation timed out.",
            httpStatus: clientAborted ? 499 : 504
          })
        );
      };
      if (input.signal?.aborted) {
        rejectForAbort();
        return;
      }
      input.signal?.addEventListener("abort", rejectForAbort, { once: true });
    });
  }
}

class FakeUpstreamV2Client implements UpstreamV2Client {
  readonly calls: UpstreamV2CreateUserInput[] = [];
  readonly disableCalls: Parameters<UpstreamV2Client["disableUser"]>[0][] = [];
  readonly revokeCalls: Parameters<UpstreamV2Client["revokeKey"]>[0][] = [];

  async createUser(input: UpstreamV2CreateUserInput) {
    this.calls.push(input);
    return {
      status: "created" as const,
      user: {
        id: `v2_${input.externalUserId}`,
        state: "active"
      },
      key: {
        id: `v2key_${input.externalUserId}`,
        key: `mev2_live_${input.externalUserId}_secret`,
        keyPrefix: `mev2_live_${input.externalUserId}`.slice(0, 24),
        issuedAt: new Date("2026-05-11T00:00:00.000Z"),
        expiresAt: null
      }
    };
  }

  async revokeKey(input: Parameters<UpstreamV2Client["revokeKey"]>[0]) {
    this.revokeCalls.push(input);
    return {
      revoked: true,
      key: {
        id: input.keyId,
        state: "revoked"
      }
    };
  }

  async disableUser(input: Parameters<UpstreamV2Client["disableUser"]>[0]) {
    this.disableCalls.push(input);
    return {
      disabled: true,
      user: {
        id: input.userId,
        state: "disabled"
      },
      revokedKeyCount: 1
    };
  }
}

describe("gateway phase 1 routes", () => {
  it("keeps health public while protecting other routes", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });

    const health = await app.inject({
      method: "GET",
      url: "/gateway/health"
    });
    expect(health.statusCode).toBe(200);
    expectRequestIdHeader(health);
    expect(health.json().auth_mode).toBe("dev");
    expect(health.json().store).toEqual({
      session: "memory",
      observation: "disabled"
    });

    const sessions = await app.inject({
      method: "GET",
      url: "/sessions"
    });
    expect(sessions.statusCode).toBe(401);
    expectRequestIdHeader(sessions);
    expect(sessions.json().error.code).toBe("missing_credential");

    await app.close();
  });

  it("exposes MedCode public metadata instead of provider implementation names", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const health = await app.inject({
      method: "GET",
      url: "/gateway/health"
    });
    expect(health.json()).toMatchObject({
      service: "medcode",
      provider: "medcode",
      phase: "controlled-trial"
    });

    const status = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(status.json().subscription).toMatchObject({
      id: "medcode",
      provider: "medcode",
      detail: "MedCode service is available."
    });
    expect(status.json().upstream_account).toMatchObject({
      label: "medcode",
      provider: "medcode",
      detail: "MedCode service is available."
    });
    expect(status.json().upstream_account).not.toHaveProperty("id");

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    expect(created.json().session.subscription_id).toBe("medcode");
    expect(created.json().session.upstream_account_label).toBe("medcode");

    const publicPayloads = [
      JSON.stringify(health.json()),
      JSON.stringify(status.json()),
      JSON.stringify(created.json())
    ].join("\n");
    expect(publicPayloads).not.toContain("openai-codex");
    expect(publicPayloads).not.toContain("codex-gateway");

    await app.close();
  });

  it("prefers credential auth when a credential store and dev token are both present", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Preferred credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const app = buildGateway({
      accessToken: "dev-secret",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const health = await app.inject({
      method: "GET",
      url: "/gateway/health"
    });
    expect(health.json().auth_mode).toBe("credential");

    const devTokenResponse = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: "Bearer dev-secret" }
    });
    expect(devTokenResponse.statusCode).toBe(401);
    expect(devTokenResponse.json().error.code).toBe("invalid_credential");

    const credentialResponse = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: `Bearer ${issued.token}` }
    });
    expect(credentialResponse.statusCode).toBe(200);

    await app.close();
  });

  it("does not reactivate disabled subjects during credential bootstrap", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Disabled default subject credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Default Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.setSubjectState("subj_dev", "disabled");

    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: `Bearer ${issued.token}` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credential");
    expect(store.getSubject("subj_dev")).toMatchObject({
      label: "Default Subject",
      state: "disabled"
    });

    await app.close();
  });

  it("validates the current API key without consuming request limits", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Client validation credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: 1
      }
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const validation = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toEqual({
      valid: true,
      subject: {
        id: "subj_dev",
        label: "Credential Subject"
      },
      credential: {
        prefix: issued.record.prefix,
        scope: "code",
        expires_at: "2030-02-01T00:00:00.000Z",
        rate: {
          requestsPerMinute: 1,
          requestsPerDay: null,
          concurrentRequests: 1
        }
      }
    });

    const firstLimitedRoute = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(firstLimitedRoute.statusCode).toBe(200);

    const secondLimitedRoute = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(secondLimitedRoute.statusCode).toBe(429);
    expect(secondLimitedRoute.json().error.code).toBe("rate_limited");

    await app.close();
  });

  it("exposes image_generation capability on current credential entitlements", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Image enabled credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.createPlan({
      id: "plan_image_v1",
      displayName: "Image Trial",
      scopeAllowlist: ["code"],
      policy: unrestrictedTokenPolicy(),
      featurePolicy: imageFeaturePolicy(),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.grantEntitlement({
      subjectId: "subj_dev",
      planId: "plan_image_v1",
      periodKind: "unlimited",
      now: new Date("2026-01-01T00:00:00Z")
    });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const current = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers: { authorization: `Bearer ${issued.token}` }
    });

    expect(current.statusCode).toBe(200);
    expect(current.json().entitlement.feature_policy).toMatchObject({
      capabilities: ["chat", "tools", "image_generation"],
      image_generation: {
        enabled: true,
        allowed_models: ["medcode-image-default"],
        default_model: "medcode-image-default",
        allowed_sizes: ["1024x1024", "1024x1536", "1536x1024", "auto"]
      }
    });

    await app.close();
  });

  it("generates images for credentials with image_generation capability", async () => {
    const { store, issued, headers } = createImageEntitledStore();
    const imageProvider = new FakeImageGenerationProvider();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      imageGenerationProvider: imageProvider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/images/generations",
      headers,
      payload: {
        model: "medcode-image-default",
        prompt: "Create a clean medical mechanism diagram.",
        size: "auto",
        metadata: {
          client: "medevidence-desktop",
          session_id: "ses_1"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expectRequestIdHeader(response);
    expect(response.json()).toMatchObject({
      id: expect.stringMatching(/^imgreq_/),
      model: "medcode-image-default",
      created: 1778123456,
      data: [
        {
          b64_json: "ZmFrZS1pbWFnZQ==",
          mime_type: "image/jpeg"
        }
      ],
      usage: {
        total_tokens: 12,
        input_tokens: 5,
        output_tokens: 7
      }
    });
    expect(imageProvider.calls).toHaveLength(1);
    expect(imageProvider.calls[0]).toMatchObject({
      upstreamModel: "gpt-image-2",
      request: {
        model: "medcode-image-default",
        size: "1024x1024",
        outputSize: "1024x1024",
        quality: "low",
        outputFormat: "jpeg"
      }
    });
    expect(imageProvider.calls[0].request.metadata).toEqual({
      client: "medevidence-desktop",
      session_id: "ses_1"
    });
    expect(issued.record.prefix).toBeTruthy();

    await app.close();
  });

  it("routes image generation through an account-bound image provider", async () => {
    const { store, headers } = createImageEntitledStore();
    const imageProvider = new FakeImageGenerationProvider();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      observationStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: testUpstreamAccount("codex-pro-1", {
            imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_A"
          }),
          provider: new FakeProvider(),
          imageProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/images/generations",
      headers,
      payload: {
        model: "medcode-image-default",
        prompt: "Create a diagram.",
        size: "1024x1024"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(imageProvider.calls).toHaveLength(1);
    expect(store.listRequestEvents({ limit: 5 })).toEqual([
      expect.objectContaining({
        upstreamAccountId: "codex-pro-1",
        status: "ok"
      })
    ]);

    await app.close();
  });

  it("records image requests when the client disconnects before the upstream response", async () => {
    const { store, headers } = createImageEntitledStore();
    const imageProvider = new HangingImageGenerationProvider();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      imageGenerationProvider: imageProvider,
      sessionStore: store,
      observationStore: store,
      logger: false
    });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;
      const request = http.request({
        method: "POST",
        host: "127.0.0.1",
        port: address.port,
        path: "/gateway/images/generations",
        headers: {
          ...headers,
          "content-type": "application/json"
        }
      });
      request.on("error", () => undefined);
      request.end(
        JSON.stringify({
          model: "medcode-image-default",
          prompt: "Create a diagram.",
          size: "1024x1024"
        })
      );

      await imageProvider.started;
      request.destroy();

      await eventually(() => {
        expect(store.listRequestEvents({ limit: 1 })).toEqual([
          expect.objectContaining({
            status: "error",
            errorCode: "client_aborted"
          })
        ]);
      });
    } finally {
      await app.close();
    }
  });

  it("returns a 504 when the image request total timeout elapses", async () => {
    const previousTimeout = process.env.MEDCODE_IMAGE_REQUEST_TIMEOUT_MS;
    process.env.MEDCODE_IMAGE_REQUEST_TIMEOUT_MS = "20";
    const accountIds = ["codex-pro-1", "codex-pro-2"];
    const issued = issueCredentialForHrwAccount("codex-pro-1", accountIds);
    const { store, headers } = createImageEntitledStore(issued);
    const firstImageProvider = new HangingImageGenerationProvider();
    const secondImageProvider = new HangingImageGenerationProvider();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      observationStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: testUpstreamAccount("codex-pro-1", {
            imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_A"
          }),
          provider: new FakeProvider(),
          imageProvider: firstImageProvider,
          maxConcurrent: 1
        },
        {
          upstreamAccount: testUpstreamAccount("codex-pro-2", {
            imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_B"
          }),
          provider: new FakeProvider(),
          imageProvider: secondImageProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/gateway/images/generations",
        headers,
        payload: {
          model: "medcode-image-default",
          prompt: "Create a diagram.",
          size: "1024x1024"
        }
      });

      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe("upstream_timeout");
      expect(firstImageProvider.calls.length + secondImageProvider.calls.length).toBe(1);
      expect(store.listRequestEvents({ limit: 1 })).toEqual([
        expect.objectContaining({
          status: "error",
          errorCode: "upstream_timeout"
        })
      ]);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.MEDCODE_IMAGE_REQUEST_TIMEOUT_MS;
      } else {
        process.env.MEDCODE_IMAGE_REQUEST_TIMEOUT_MS = previousTimeout;
      }
      await app.close();
    }
  });

  it("does not fall back to the legacy image provider when image binding is declared but unavailable", async () => {
    const { store, headers } = createImageEntitledStore();
    const legacyImageProvider = new FakeImageGenerationProvider();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      imageGenerationProvider: legacyImageProvider,
      sessionStore: store,
      observationStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: testUpstreamAccount("codex-pro-1", {
            imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_A"
          }),
          provider: new FakeProvider(),
          imageProvider: null,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/images/generations",
      headers,
      payload: {
        model: "medcode-image-default",
        prompt: "Create a diagram.",
        size: "1024x1024"
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("upstream_unavailable");
    expect(legacyImageProvider.calls).toHaveLength(0);

    await app.close();
  });

  it("retries image generation on another account after key invalid", async () => {
    const accountIds = ["codex-pro-1", "codex-pro-2"];
    const issued = issueCredentialForHrwAccount("codex-pro-1", accountIds);
    const { store, headers } = createImageEntitledStore(issued);
    const firstImageProvider = new FakeImageGenerationProvider(
      new GatewayError({
        code: "upstream_unavailable",
        message: "Image generation service is unavailable.",
        httpStatus: 503,
        upstreamStatus: 401
      })
    );
    const secondImageProvider = new FakeImageGenerationProvider();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      observationStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: testUpstreamAccount("codex-pro-1", {
            imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_A"
          }),
          provider: new FakeProvider(),
          imageProvider: firstImageProvider,
          maxConcurrent: 1
        },
        {
          upstreamAccount: testUpstreamAccount("codex-pro-2", {
            imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_B"
          }),
          provider: new FakeProvider(),
          imageProvider: secondImageProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/images/generations",
      headers,
      payload: {
        model: "medcode-image-default",
        prompt: "Create a diagram.",
        size: "1024x1024"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(firstImageProvider.calls).toHaveLength(1);
    expect(secondImageProvider.calls).toHaveLength(1);
    expect(store.listRequestEvents({ limit: 5 })).toEqual([
      expect.objectContaining({
        upstreamAccountId: "codex-pro-2",
        status: "ok"
      })
    ]);

    await app.close();
  });

  it("uses the billing fallback image provider with gpt-image-1.5 after billing hard limit", async () => {
    const { store, headers } = createImageEntitledStore();
    const primaryImageProvider = new FakeImageGenerationProvider(
      new GatewayError({
        code: "upstream_unavailable",
        message: "Billing hard limit has been reached.",
        httpStatus: 503,
        upstreamStatus: 400
      })
    );
    const fallbackImageProvider = new FakeImageGenerationProvider();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      observationStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: testUpstreamAccount("codex-pro-1", {
            imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_A"
          }),
          provider: new FakeProvider(),
          imageProvider: primaryImageProvider,
          maxConcurrent: 1
        }
      ],
      imageGenerationBillingFallbackProvider: fallbackImageProvider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/images/generations",
      headers,
      payload: {
        model: "medcode-image-default",
        prompt: "Create a diagram.",
        size: "1024x1024"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(primaryImageProvider.calls).toHaveLength(1);
    expect(primaryImageProvider.calls[0].upstreamModel).toBe("gpt-image-2");
    expect(fallbackImageProvider.calls).toHaveLength(1);
    expect(fallbackImageProvider.calls[0].upstreamModel).toBe("gpt-image-1.5");
    expect(store.listRequestEvents({ limit: 5 })).toEqual([
      expect.objectContaining({
        upstreamAccountId: "image-billing-fallback",
        status: "ok"
      })
    ]);

    await app.close();
  });

  it("rejects image generation without image_generation capability using the client error shape", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Chat only credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.createPlan({
      id: "plan_chat_v1",
      displayName: "Chat Only",
      scopeAllowlist: ["code"],
      policy: unrestrictedTokenPolicy(),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.grantEntitlement({
      subjectId: "subj_dev",
      planId: "plan_chat_v1",
      periodKind: "unlimited",
      now: new Date("2026-01-01T00:00:00Z")
    });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      imageGenerationProvider: new FakeImageGenerationProvider(),
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/images/generations",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode-image-default",
        prompt: "Create a diagram.",
        size: "1024x1024"
      }
    });
    const requestId = expectRequestIdHeader(response);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "plan_capability_required",
        message: "This credential is not entitled for image generation.",
        request_id: requestId
      }
    });

    await app.close();
  });

  it("rejects invalid API keys on the current credential validation route", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers: { authorization: "Bearer wrong" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credential");

    await app.close();
  });

  it("resolves Gateway-brokered unified client keys without accepting them as Gateway credentials", async () => {
    const previousSecret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
    const previousPublicBaseUrl = process.env.GATEWAY_PUBLIC_BASE_URL;
    const encryptionSecret = "unified-resolver-test-secret";
    process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET = encryptionSecret;
    process.env.GATEWAY_PUBLIC_BASE_URL = "https://gateway.example";

    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Unified backing credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    const medevidenceKey = "mev2_live_resolver_test_secret_1234567890";
    const unified = issueUnifiedClientKey({
      subjectId: "subj_dev",
      label: "Desktop unified key",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      codexCredentialId: issued.record.id,
      codexCredentialPrefix: issued.record.prefix,
      codexKeyCiphertext: encryptSecret(issued.token, encryptionSecret),
      medevidenceKeyCiphertext: encryptSecret(medevidenceKey, encryptionSecret),
      medevidenceKeyPrefix: "mev2_live_resolver",
      metadata: {
        medevidence_base_url: "https://medevidence.example/"
      },
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.insertUnifiedClientKey(unified.record);
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    try {
      const resolved = await app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: { authorization: `Bearer ${unified.token}` }
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({
        valid: true,
        unified_key: {
          prefix: unified.record.prefix,
          label: "Desktop unified key",
          expires_at: "2030-02-01T00:00:00.000Z"
        },
        subject: {
          id: "subj_dev",
          label: "Credential Subject"
        },
        codex_gateway: {
          endpoint_base_url: "https://gateway.example/v1",
          credential_validation_url: "https://gateway.example/gateway/credentials/current",
          key_prefix: issued.record.prefix,
          api_key: issued.token
        },
        medevidence: {
          base_url: "https://medevidence.example",
          key_prefix: "mev2_live_resolver",
          api_key: medevidenceKey
        }
      });
      expect(JSON.stringify(resolved.json())).not.toContain(unified.token);
      expect(store.listAdminAuditEvents({ action: "unified-key-resolve" })).toEqual([
        expect.objectContaining({
          action: "unified-key-resolve",
          targetUserId: "subj_dev",
          targetCredentialId: unified.record.id,
          targetCredentialPrefix: unified.record.prefix,
          status: "ok",
          errorMessage: null,
          params: {
            codex_credential_prefix: issued.record.prefix,
            medevidence_key_prefix: "mev2_live_resolver"
          }
        })
      ]);

      const directGatewayUse = await app.inject({
        method: "GET",
        url: "/gateway/status",
        headers: { authorization: `Bearer ${unified.token}` }
      });
      expect(directGatewayUse.statusCode).toBe(401);
      expect(directGatewayUse.json().error.code).toBe("invalid_credential");

      const gatewayCredentialOnResolve = await app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: { authorization: `Bearer ${issued.token}` }
      });
      expect(gatewayCredentialOnResolve.statusCode).toBe(401);
      expect(gatewayCredentialOnResolve.json().error.code).toBe("invalid_credential");

      store.revokeAccessCredentialByPrefix(issued.record.prefix, new Date("2026-01-02T00:00:00Z"));
      const revokedBackingCredential = await app.inject({
        method: "POST",
        url: "/gateway/unified-keys/resolve",
        headers: { authorization: `Bearer ${unified.token}` }
      });
      expect(revokedBackingCredential.statusCode).toBe(401);
      expect(revokedBackingCredential.json().error.code).toBe("revoked_credential");
    } finally {
      await app.close();
      if (previousSecret === undefined) {
        delete process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
      } else {
        process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET = previousSecret;
      }
      if (previousPublicBaseUrl === undefined) {
        delete process.env.GATEWAY_PUBLIC_BASE_URL;
      } else {
        process.env.GATEWAY_PUBLIC_BASE_URL = previousPublicBaseUrl;
      }
    }
  });

  it("serves billing admin plans, entitlement events, entitlements, and usage behind a separate token", async () => {
    const { store, issued } = createCredentialBackedStore();
    store.createPlan({
      id: "plan_billing_v1",
      displayName: "Billing Pro",
      scopeAllowlist: ["code"],
      policy: unrestrictedTokenPolicy(),
      featurePolicy: imageFeaturePolicy(),
      now: new Date("2026-05-01T00:00:00Z")
    });
    store.insertRequestEvent({
      requestId: "req_billing_usage",
      credentialId: issued.record.id,
      subjectId: "subj_dev",
      scope: "code",
      sessionId: null,
      upstreamAccountId: "sub_openai_codex",
      provider: "openai-codex",
      startedAt: new Date("2026-05-12T03:00:00Z"),
      durationMs: 10,
      firstByteMs: 5,
      status: "ok",
      errorCode: null,
      rateLimited: false,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedPromptTokens: 0,
      estimatedTokens: null,
      usageSource: "provider"
    });
    const billingHeaders = { authorization: "Bearer billing-admin-token-1234567890" };
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      billingAdminToken: "billing-admin-token-1234567890",
      now: () => new Date("2026-05-20T00:00:00Z"),
      logger: false
    });

    const ordinaryCredential = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: { authorization: `Bearer ${issued.token}` }
    });
    expect(ordinaryCredential.statusCode).toBe(401);
    expect(ordinaryCredential.json().error.code).toBe("invalid_credential");

    const plans = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: billingHeaders
    });
    expect(plans.statusCode).toBe(200);
    expect(plans.headers["cache-control"]).toBe("no-store");
    expect(plans.json().plans).toEqual([
      expect.objectContaining({
        id: "plan_billing_v1",
        display_name: "Billing Pro",
        feature_policy: expect.objectContaining({
          capabilities: ["chat", "tools", "image_generation"]
        })
      })
    ]);

    const purchasePayload = {
      event_type: "purchase",
      apply_mode: "apply",
      provider: "stripe",
      external_order_id: "pay_123",
      external_event_id: "evt_123",
      subject_id: "subj_dev",
      plan_id: "plan_billing_v1",
      period_kind: "monthly",
      period_start: "2026-05-11T00:00:00.000Z",
      period_end: "2030-06-11T00:00:00.000Z",
      amount_minor: 1999,
      currency: "USD",
      metadata: {
        sku: "medcode_pro_monthly"
      }
    };
    const purchase = await app.inject({
      method: "POST",
      url: "/gateway/admin/billing/v1/entitlement-events",
      headers: {
        ...billingHeaders,
        "Idempotency-Key": "stripe:pay_123:purchase"
      },
      payload: purchasePayload
    });
    const requestId = expectRequestIdHeader(purchase);
    expect(purchase.statusCode).toBe(200);
    expect(purchase.json()).toMatchObject({
      applied: true,
      idempotent_replay: false,
      billing_event: {
        provider: "stripe",
        external_order_id: "pay_123",
        event_type: "purchase",
        apply_mode: "apply",
        status: "applied"
      },
      plan: {
        id: "plan_billing_v1",
        display_name: "Billing Pro"
      },
      entitlement: {
        plan_id: "plan_billing_v1",
        period_kind: "monthly",
        period_start: "2026-05-11T00:00:00.000Z",
        period_end: "2030-06-11T00:00:00.000Z",
        state: "active"
      },
      cancelled_entitlement_ids: []
    });
    expect(purchase.json().error).toBeUndefined();
    expect(requestId).toMatch(/^req-/);

    const replay = await app.inject({
      method: "POST",
      url: "/gateway/admin/billing/v1/entitlement-events",
      headers: {
        ...billingHeaders,
        "Idempotency-Key": "stripe:pay_123:purchase"
      },
      payload: purchasePayload
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      applied: true,
      idempotent_replay: true
    });
    expect(replay.json().entitlement.id).toBe(purchase.json().entitlement.id);

    const conflict = await app.inject({
      method: "POST",
      url: "/gateway/admin/billing/v1/entitlement-events",
      headers: {
        ...billingHeaders,
        "Idempotency-Key": "stripe:pay_123:purchase"
      },
      payload: {
        ...purchasePayload,
        amount_minor: 2999
      }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");

    const event = await app.inject({
      method: "GET",
      url: `/gateway/admin/billing/v1/entitlement-events/${encodeURIComponent("stripe:pay_123:purchase")}`,
      headers: billingHeaders
    });
    expect(event.statusCode).toBe(200);
    expect(event.json().billing_event).toMatchObject({
      idempotency_key: "stripe:pay_123:purchase",
      status: "applied",
      entitlement_id: purchase.json().entitlement.id
    });

    const entitlements = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/users/subj_dev/entitlements",
      headers: billingHeaders
    });
    expect(entitlements.statusCode).toBe(200);
    expect(entitlements.json().current).toMatchObject({
      id: purchase.json().entitlement.id,
      plan_id: "plan_billing_v1"
    });

    const usage = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/usage?subject_id=subj_dev&from=2026-05-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z&group_by=day",
      headers: billingHeaders
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().rows).toEqual([
      {
        period_start: "2026-05-12T00:00:00.000Z",
        request_count: 1,
        success_count: 1,
        error_count: 0,
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        estimated_tokens: 0
      }
    ]);

    await app.close();
  });

  it("resets request and token quota through billing admin", async () => {
    const tokenPolicy = {
      tokensPerMinute: null,
      tokensPerDay: 100,
      tokensPerMonth: 1_000,
      maxPromptTokensPerRequest: null,
      maxTotalTokensPerRequest: null,
      reserveTokensPerRequest: 0,
      missingUsageCharge: "none" as const
    };
    const { store, issued, headers } = createCredentialBackedStore({
      requestsPerMinute: 100,
      requestsPerDay: 1,
      concurrentRequests: 1
    });
    const fixedNow = () => new Date("2026-05-21T12:00:00Z");
    const rateLimiter = new InMemoryCredentialRateLimiter({
      now: fixedNow
    });
    store.createPlan({
      id: "plan_quota_reset_v1",
      displayName: "Quota Reset",
      scopeAllowlist: ["code"],
      policy: tokenPolicy,
      featurePolicy: imageFeaturePolicy(),
      now: new Date("2026-05-01T00:00:00Z")
    });
    const entitlement = store.grantEntitlement({
      subjectId: "subj_dev",
      planId: "plan_quota_reset_v1",
      periodKind: "one_off",
      periodStart: new Date("2026-05-01T00:00:00Z"),
      periodEnd: new Date("2026-06-01T00:00:00Z"),
      now: new Date("2026-05-01T00:00:00Z")
    });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider([
        { type: "message_delta", text: "ok" },
        {
          type: "completed",
          providerSessionRef: "provider_thread_quota_reset",
          usage: { promptTokens: 20, completionTokens: 40, totalTokens: 60 }
        }
      ]),
      sessionStore: store,
      rateLimiter,
      billingAdminToken: "billing-admin-token-1234567890",
      now: fixedNow,
      logger: false
    });
    const chatPayload = {
      model: "medcode",
      messages: [{ role: "user", content: "hello" }]
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: chatPayload
    });
    expect(first.statusCode).toBe(200);

    const limited = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: chatPayload
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");

    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const beforeResetUsage = await limiter.getCurrentUsage({
      subjectId: "subj_dev",
      entitlementId: entitlement.id,
      entitlementPeriodStart: entitlement.periodStart,
      entitlementPeriodEnd: entitlement.periodEnd,
      policy: tokenPolicy,
      now: new Date("2026-05-21T12:00:00Z")
    });
    expect(beforeResetUsage.day.used).toBe(60);

    const reset = await app.inject({
      method: "POST",
      url: "/gateway/admin/billing/v1/users/subj_dev/quota-reset",
      headers: { authorization: "Bearer billing-admin-token-1234567890" },
      payload: {
        request_windows: ["day"],
        token_windows: ["day"],
        reason: "support reset"
      }
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      subject_id: "subj_dev",
      credential_prefixes: [issued.record.prefix],
      request_reset: {
        status: "reset",
        windows: ["day"]
      },
      token_reset: {
        status: "reset",
        source: "entitlement",
        entitlement_id: entitlement.id,
        windows: ["day"],
        usage_before: {
          day: {
            used: 60
          }
        },
        usage_after: {
          day: {
            used: 0
          },
          month: {
            used: 60
          }
        }
      }
    });

    const afterReset = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: chatPayload
    });
    expect(afterReset.statusCode).toBe(200);

    expect(
      store.listAdminAuditEvents({ action: "quota-reset", limit: 1 })[0]
    ).toMatchObject({
      action: "quota-reset",
      targetUserId: "subj_dev",
      status: "ok"
    });

    await app.close();
  });

  it("authenticates billing admin routes with a DB token without an env token", async () => {
    const { store } = createCredentialBackedStore();
    store.createPlan({
      id: "plan_billing_db_v1",
      displayName: "Billing DB Token",
      scopeAllowlist: ["code"],
      policy: unrestrictedTokenPolicy(),
      featurePolicy: imageFeaturePolicy(),
      now: new Date("2026-05-01T00:00:00Z")
    });
    const billingToken = issueBillingAdminToken({
      label: "Payment joint test",
      kind: "test",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      now: new Date("2026-05-01T00:00:00Z")
    });
    store.insertBillingAdminToken(billingToken.record);

    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      billingAdminTokenMode: "db",
      logger: false
    });

    const plans = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: { authorization: `Bearer ${billingToken.token}` }
    });
    expect(plans.statusCode).toBe(200);
    expect(plans.json().plans).toEqual([
      expect.objectContaining({
        id: "plan_billing_db_v1",
        display_name: "Billing DB Token"
      })
    ]);
    const firstLastUsedAt = store
      .getBillingAdminTokenByPrefix(billingToken.record.prefix)
      ?.lastUsedAt?.toISOString();
    expect(firstLastUsedAt).toBeTruthy();

    const secondPlans = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: { authorization: `Bearer ${billingToken.token}` }
    });
    expect(secondPlans.statusCode).toBe(200);
    expect(
      store.getBillingAdminTokenByPrefix(billingToken.record.prefix)?.lastUsedAt?.toISOString()
    ).toBe(firstLastUsedAt);

    const envStyleToken = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: { authorization: "Bearer billing-admin-token-1234567890" }
    });
    expect(envStyleToken.statusCode).toBe(401);

    store.revokeBillingAdminTokenByPrefix(billingToken.record.prefix);
    const revoked = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: { authorization: `Bearer ${billingToken.token}` }
    });
    expect(revoked.statusCode).toBe(401);

    const expiredBillingToken = issueBillingAdminToken({
      label: "Expired payment joint test",
      kind: "test",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      now: new Date("2019-12-01T00:00:00Z")
    });
    store.insertBillingAdminToken(expiredBillingToken.record);
    const expired = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: { authorization: `Bearer ${expiredBillingToken.token}` }
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe("invalid_credential");

    await app.close();
  });

  it("uses non-bat env billing admin tokens as fallback in hybrid and env modes", async () => {
    for (const mode of ["hybrid", "env"] as const) {
      const { store } = createCredentialBackedStore();
      store.createPlan({
        id: `plan_billing_env_fallback_${mode}_v1`,
        displayName: "Billing Env Fallback",
        scopeAllowlist: ["code"],
        policy: unrestrictedTokenPolicy(),
        featurePolicy: imageFeaturePolicy(),
        now: new Date("2026-05-01T00:00:00Z")
      });
      store.getBillingAdminTokenByPrefix = () => {
        throw new Error("DB lookup should be skipped for non-bat env token");
      };
      const app = buildGateway({
        authMode: "credential",
        provider: new FakeProvider(),
        sessionStore: store,
        billingAdminToken: "billing-admin-token-1234567890",
        billingAdminTokenMode: mode,
        logger: false
      });
      const plans = await app.inject({
        method: "GET",
        url: "/gateway/admin/billing/v1/plans",
        headers: { authorization: "Bearer billing-admin-token-1234567890" }
      });
      expect(plans.statusCode).toBe(200);
      expect(plans.json().plans[0]).toMatchObject({
        id: `plan_billing_env_fallback_${mode}_v1`
      });
      await app.close();
    }
  });

  it("does not fall back to env tokens for bat-shaped values in hybrid mode", async () => {
    const { store } = createCredentialBackedStore();
    store.createPlan({
      id: "plan_billing_bat_env_v1",
      displayName: "Billing Bat Env",
      scopeAllowlist: ["code"],
      policy: unrestrictedTokenPolicy(),
      featurePolicy: imageFeaturePolicy(),
      now: new Date("2026-05-01T00:00:00Z")
    });
    const batShapedEnvToken = `bat_test_${"x".repeat(12)}.${"y".repeat(20)}`;
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      billingAdminToken: batShapedEnvToken,
      billingAdminTokenMode: "hybrid",
      logger: false
    });

    const plans = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: { authorization: `Bearer ${batShapedEnvToken}` }
    });
    expect(plans.statusCode).toBe(401);
    expect(plans.json().error.code).toBe("invalid_credential");

    await app.close();
  });

  it("keeps DB billing admin auth successful when last_used_at tracking fails", async () => {
    const { store } = createCredentialBackedStore();
    store.createPlan({
      id: "plan_billing_tracking_v1",
      displayName: "Billing Tracking Failure",
      scopeAllowlist: ["code"],
      policy: unrestrictedTokenPolicy(),
      featurePolicy: imageFeaturePolicy(),
      now: new Date("2026-05-01T00:00:00Z")
    });
    const billingToken = issueBillingAdminToken({
      label: "Payment tracking test",
      kind: "test",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      now: new Date("2026-05-01T00:00:00Z")
    });
    store.insertBillingAdminToken(billingToken.record);
    store.updateBillingAdminTokenLastUsedAt = () => {
      throw new Error(`write failed for ${billingToken.token}`);
    };

    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      billingAdminTokenMode: "db",
      logger: false
    });

    const plans = await app.inject({
      method: "GET",
      url: "/gateway/admin/billing/v1/plans",
      headers: { authorization: `Bearer ${billingToken.token}` }
    });
    expect(plans.statusCode).toBe(200);
    expect(plans.json().plans[0]).toMatchObject({
      id: "plan_billing_tracking_v1"
    });

    await app.close();
  });

  it("creates billing subjects through v2 provisioning and returns an opaque key only once", async () => {
    const previousSecret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
    process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET = "billing-subject-secret-1234567890";
    const store = createSqliteStore({ path: ":memory:" });
    const upstreamV2Client = new FakeUpstreamV2Client();
    const billingHeaders = { authorization: "Bearer billing-admin-token-1234567890" };
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      billingAdminToken: "billing-admin-token-1234567890",
      upstreamV2Client,
      logger: false
    });
    const payload = {
      provider: "medevidence_billing",
      external_user_id: "bu_abc123",
      display_name: "Alice",
      metadata: {
        signup_source: "web"
      }
    };

    try {
      const created = await app.inject({
        method: "POST",
        url: "/gateway/admin/billing/v1/subjects",
        headers: {
          ...billingHeaders,
          "Idempotency-Key": "medevidence_billing:bu_abc123:create_subject"
        },
        payload
      });

      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        created: true,
        idempotent_replay: false,
        subject: {
          provider: "medevidence_billing",
          external_user_id: "bu_abc123",
          display_name: "Alice",
          scope_allowlist: ["code"],
          state: "active"
        },
        credential: {
          key_prefix: expect.stringMatching(/^cgu_live_[A-Za-z0-9]{16}$/),
          state: "active"
        }
      });
      expect(created.json().credential.key).toMatch(/^cgu_live_[A-Za-z0-9]{64}$/);
      expect(upstreamV2Client.calls).toHaveLength(1);
      expect(upstreamV2Client.calls[0]).toMatchObject({
        externalProvider: "medevidence_backend",
        displayName: "Alice",
        idempotencyKey: expect.stringMatching(/^medevidence:subj_[A-Za-z0-9_-]{24}:create_user$/)
      });
      expect(JSON.stringify(upstreamV2Client.calls[0])).not.toContain("scope_allowlist");

      const replay = await app.inject({
        method: "POST",
        url: "/gateway/admin/billing/v1/subjects",
        headers: {
          ...billingHeaders,
          "Idempotency-Key": "medevidence_billing:bu_abc123:create_subject"
        },
        payload
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        created: false,
        idempotent_replay: true,
        subject: {
          id: created.json().subject.id
        }
      });
      expect(replay.json().credential).not.toHaveProperty("key");
      expect(upstreamV2Client.calls).toHaveLength(1);

      const byExternal = await app.inject({
        method: "GET",
        url: "/gateway/admin/billing/v1/subjects?provider=medevidence_billing&external_user_id=bu_abc123",
        headers: billingHeaders
      });
      expect(byExternal.statusCode).toBe(200);
      expect(byExternal.json()).toMatchObject({
        subject: {
          id: created.json().subject.id,
          external_user_id: "bu_abc123"
        },
        credentials: [
          expect.objectContaining({
            key_prefix: created.json().credential.key_prefix
          })
        ]
      });
      expect(JSON.stringify(byExternal.json())).not.toContain(created.json().credential.key);

      const duplicateExternal = await app.inject({
        method: "POST",
        url: "/gateway/admin/billing/v1/subjects",
        headers: {
          ...billingHeaders,
          "Idempotency-Key": "medevidence_billing:bu_abc123:create_subject:second"
        },
        payload
      });
      expect(duplicateExternal.statusCode).toBe(409);
      expect(duplicateExternal.json().error.code).toBe("subject_already_exists");
      expect(upstreamV2Client.calls).toHaveLength(1);

      const rotated = await app.inject({
        method: "POST",
        url: `/gateway/admin/billing/v1/subjects/${created.json().subject.id}/keys`,
        headers: {
          ...billingHeaders,
          "Idempotency-Key": "medevidence_billing:bu_abc123:rotate_key:req_1"
        },
        payload: {
          reason: "user_lost_key"
        }
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json()).toMatchObject({
        rotated: true,
        idempotent_replay: false,
        subject: {
          id: created.json().subject.id,
          state: "active"
        },
        credential: {
          key_prefix: expect.stringMatching(/^cgu_live_[A-Za-z0-9]{16}$/),
          state: "active"
        },
        revoked_credential_ids: [expect.any(String)],
        revoked_unified_key_ids: [created.json().credential.id]
      });
      expect(rotated.json().credential.key).toMatch(/^cgu_live_[A-Za-z0-9]{64}$/);
      expect(rotated.json().credential.key).not.toBe(created.json().credential.key);

      const rotateReplay = await app.inject({
        method: "POST",
        url: `/gateway/admin/billing/v1/subjects/${created.json().subject.id}/keys`,
        headers: {
          ...billingHeaders,
          "Idempotency-Key": "medevidence_billing:bu_abc123:rotate_key:req_1"
        },
        payload: {
          reason: "user_lost_key"
        }
      });
      expect(rotateReplay.statusCode).toBe(200);
      expect(rotateReplay.json()).toMatchObject({
        rotated: false,
        idempotent_replay: true
      });
      expect(rotateReplay.json().credential).not.toHaveProperty("key");

      const disabled = await app.inject({
        method: "POST",
        url: `/gateway/admin/billing/v1/subjects/${created.json().subject.id}/disable`,
        headers: {
          ...billingHeaders,
          "Idempotency-Key": "medevidence_billing:bu_abc123:disable_subject:evt_1"
        },
        payload: {
          reason: "user_requested_deletion"
        }
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({
        disabled: true,
        idempotent_replay: false,
        subject: {
          id: created.json().subject.id,
          state: "disabled"
        },
        revoked_unified_key_ids: expect.arrayContaining([rotated.json().credential.id])
      });
      expect(upstreamV2Client.disableCalls).toHaveLength(1);
      expect(upstreamV2Client.disableCalls[0]).toMatchObject({
        externalUserId: created.json().subject.id,
        idempotencyKey: `medevidence:${created.json().subject.id}:disable_user`
      });

      const disableReplay = await app.inject({
        method: "POST",
        url: `/gateway/admin/billing/v1/subjects/${created.json().subject.id}/disable`,
        headers: {
          ...billingHeaders,
          "Idempotency-Key": "medevidence_billing:bu_abc123:disable_subject:evt_1"
        },
        payload: {
          reason: "user_requested_deletion"
        }
      });
      expect(disableReplay.statusCode).toBe(200);
      expect(disableReplay.json()).toMatchObject({
        disabled: false,
        idempotent_replay: true,
        subject: {
          state: "disabled"
        }
      });
      expect(upstreamV2Client.disableCalls).toHaveLength(1);
    } finally {
      await app.close();
      if (previousSecret === undefined) {
        delete process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
      } else {
        process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET = previousSecret;
      }
    }
  });

  it("sends a non-PII default display name to v2 when billing display name is omitted", async () => {
    const previousSecret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
    process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET = "billing-subject-secret-1234567890";
    const store = createSqliteStore({ path: ":memory:" });
    const upstreamV2Client = new FakeUpstreamV2Client();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      billingAdminToken: "billing-admin-token-1234567890",
      upstreamV2Client,
      logger: false
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/gateway/admin/billing/v1/subjects",
        headers: {
          authorization: "Bearer billing-admin-token-1234567890",
          "Idempotency-Key": "medevidence_billing:bu_no_name:create_subject"
        },
        payload: {
          provider: "medevidence_billing",
          external_user_id: "bu_no_name",
          metadata: {
            signup_source: "web"
          }
        }
      });

      expect(created.statusCode).toBe(200);
      const subjectId = created.json().subject.id;
      expect(created.json().subject.display_name).toBeNull();
      expect(upstreamV2Client.calls).toHaveLength(1);
      expect(upstreamV2Client.calls[0]).toMatchObject({
        externalProvider: "medevidence_backend",
        externalUserId: subjectId,
        displayName: `internal:${subjectId}`
      });
    } finally {
      await app.close();
      if (previousSecret === undefined) {
        delete process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
      } else {
        process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET = previousSecret;
      }
    }
  });

  it("rejects billing subject external_user_id values that cannot be parsed in v2 idempotency keys", async () => {
    const { store } = createCredentialBackedStore();
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      billingAdminToken: "billing-admin-token-1234567890",
      upstreamV2Client: new FakeUpstreamV2Client(),
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/admin/billing/v1/subjects",
      headers: {
        authorization: "Bearer billing-admin-token-1234567890",
        "Idempotency-Key": "medevidence_billing:bu:bad:create_subject"
      },
      payload: {
        provider: "medevidence_billing",
        external_user_id: "bu:bad"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_external_user_id");

    await app.close();
  });

  it("rejects sensitive billing metadata before creating an idempotency row", async () => {
    const { store } = createCredentialBackedStore();
    store.createPlan({
      id: "plan_billing_sensitive_v1",
      displayName: "Billing Sensitive",
      scopeAllowlist: ["code"],
      policy: unrestrictedTokenPolicy(),
      now: new Date("2026-05-01T00:00:00Z")
    });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      billingAdminToken: "billing-admin-token-1234567890",
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/admin/billing/v1/entitlement-events",
      headers: {
        authorization: "Bearer billing-admin-token-1234567890",
        "Idempotency-Key": "stripe:pay_sensitive:purchase"
      },
      payload: {
        event_type: "purchase",
        provider: "stripe",
        external_order_id: "pay_sensitive",
        subject_id: "subj_dev",
        plan_id: "plan_billing_sensitive_v1",
        period_kind: "monthly",
        period_start: "2026-05-11T00:00:00.000Z",
        period_end: "2026-06-11T00:00:00.000Z",
        metadata: {
          customer_email: "user@example.com"
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(store.listBillingEvents().events).toEqual([]);

    await app.close();
  });

  it("does not expose internal token budget policy fields on public credential routes", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Token policy credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 30,
        requestsPerDay: null,
        concurrentRequests: 1,
        token: {
          tokensPerMinute: 1_000,
          tokensPerDay: 10_000,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: 500,
          maxTotalTokensPerRequest: 1_000,
          reserveTokensPerRequest: 100,
          missingUsageCharge: "reserve"
        }
      }
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const status = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    const current = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers
    });

    expect(status.statusCode).toBe(200);
    expect(current.statusCode).toBe(200);
    expect(status.json().credential.rate.token).toEqual({
      tokensPerMinute: 1_000,
      tokensPerDay: 10_000,
      tokensPerMonth: null,
      maxPromptTokensPerRequest: 500,
      maxTotalTokensPerRequest: 1_000
    });
    expect(current.json().credential.token).toEqual(status.json().credential.rate.token);
    expect(JSON.stringify(status.json())).not.toContain("reserveTokensPerRequest");
    expect(JSON.stringify(status.json())).not.toContain("missingUsageCharge");
    expect(JSON.stringify(current.json())).not.toContain("reserveTokensPerRequest");
    expect(JSON.stringify(current.json())).not.toContain("missingUsageCharge");

    await app.close();
  });

  it("returns service_unavailable for client message events when storage is not configured", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      clientEventsStore: null,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      payload: clientMessagePayload()
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("service_unavailable");

    await app.close();
  });

  it("writes client message events to the dedicated store without request observation", async () => {
    const { store, issued, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_write_1",
        text: "系统性红斑狼疮最新研究进展",
        attachments: [
          {
            type: "file",
            filename: "report.pdf",
            mime: "application/pdf",
            size: 123456
          }
        ]
      })
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ok: true,
      event_id: "evt_write_1",
      duplicate: false
    });
    const stored = clientEventsStore.getClientMessageEvent("subj_dev", "evt_write_1");
    expect(stored).toMatchObject({
      eventId: "evt_write_1",
      credentialId: issued.record.id,
      subjectId: "subj_dev",
      scope: "code",
      sessionId: "ses_1",
      messageId: "msg_1",
      text: "系统性红斑狼疮最新研究进展",
      appName: "medevidence-desktop",
      appVersion: "1.4.6"
    });
    expect(stored?.textSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(stored?.attachmentsJson ?? "[]")).toEqual([
      {
        type: "file",
        filename: "report.pdf",
        mime: "application/pdf",
        size: 123456
      }
    ]);
    expect(store.listRequestEvents()).toEqual([]);

    await app.close();
  });

  it("serves the admin client message UI and protects all-user message data", async () => {
    const { store, issued, headers } = createCredentialBackedStore();
    const second = issueAccessCredential({
      subjectId: "subj_zhang",
      label: "Second client event credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    const smoke = issueAccessCredential({
      subjectId: "openai-public-smoke-123",
      label: "Public smoke event credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_zhang",
      label: "Zhang Sheng",
      name: "张晟",
      phoneNumber: "15618504630",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "openai-public-smoke-123",
      label: "public-openai-smoke",
      name: "Public OpenAI Smoke",
      phoneNumber: "+15550000000",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(second.record);
    store.insertAccessCredential(smoke.record);
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      adminMessagesToken: "admin-messages-token-1234567890",
      logger: false
    });

    const page = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages"
    });
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages.json"
    });
    const userCredential = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages.json",
      headers
    });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Gateway Client Messages");
    expect(page.body).toContain('id="userSearch"');
    expect(page.body).toContain('id="userList"');
    expect(page.body).not.toContain('list="subjects"');
    expect(page.body).toContain("Admin token required");
    expect(unauthenticated.statusCode).toBe(401);
    expect(userCredential.statusCode).toBe(401);

    await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_admin_1",
        session_id: "ses_admin_1",
        message_id: "msg_admin_1",
        text: "First user private prompt"
      })
    });
    await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers: { authorization: `Bearer ${second.token}` },
      payload: clientMessagePayload({
        event_id: "evt_admin_2",
        session_id: "ses_admin_2",
        message_id: "msg_admin_2",
        text: "Second user detailed prompt"
      })
    });
    await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers: { authorization: `Bearer ${smoke.token}` },
      payload: clientMessagePayload({
        event_id: "evt_admin_smoke_1",
        session_id: "ses_admin_smoke_1",
        message_id: "msg_admin_smoke_1",
        text: "Smoke prompt should be hidden"
      })
    });

    const preview = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages.json?limit=10",
      headers: { authorization: "Bearer admin-messages-token-1234567890" }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().messages).toHaveLength(2);
    expect(preview.json().messages[0].text).toBeUndefined();
    expect(JSON.stringify(preview.json()).toLowerCase()).not.toContain("smoke");
    expect(JSON.stringify(preview.json())).not.toContain(issued.token);
    expect(JSON.stringify(preview.json())).not.toContain(second.token);
    expect(JSON.stringify(preview.json())).not.toContain(smoke.token);
    expect(JSON.stringify(preview.json())).not.toContain("admin-messages-token-1234567890");

    const full = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages.json?user=%E5%BC%A0%E6%99%9F&include_text=1&limit=10",
      headers: { authorization: "Bearer admin-messages-token-1234567890" }
    });
    expect(full.statusCode).toBe(200);
    expect(full.json().messages).toHaveLength(1);
    expect(full.json().messages[0]).toMatchObject({
      subject: {
        id: "subj_zhang",
        name: "张晟",
        phone_number: "15618504630"
      },
      credential: {
        prefix: second.record.prefix
      },
      text: "Second user detailed prompt"
    });

    const smokeQuery = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages.json?user=smoke&include_text=1&limit=10",
      headers: { authorization: "Bearer admin-messages-token-1234567890" }
    });
    expect(smokeQuery.statusCode).toBe(200);
    expect(smokeQuery.json().messages).toEqual([]);
    expect(JSON.stringify(smokeQuery.json().subjects).toLowerCase()).not.toContain("smoke");
    expect(JSON.stringify(smokeQuery.json().messages).toLowerCase()).not.toContain("smoke");

    await app.close();
  });

  it("can temporarily expose the admin client message UI without a token", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      adminMessagesAuthMode: "open",
      logger: false
    });

    await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_admin_open_1",
        text: "Open admin dashboard prompt"
      })
    });

    const page = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages"
    });
    const data = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages.json?include_text=1"
    });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Open access");
    expect(page.body).toContain("const authRequired = false");
    expect(page.body).not.toContain('id="token"');
    expect(data.statusCode).toBe(200);
    expect(data.json().messages[0]).toMatchObject({
      text: "Open admin dashboard prompt"
    });

    await app.close();
  });

  it("hides the admin client message UI when the admin token is not configured", async () => {
    const { store } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const page = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages"
    });
    const data = await app.inject({
      method: "GET",
      url: "/gateway/admin/client-messages.json"
    });

    expect(page.statusCode).toBe(404);
    expect(data.statusCode).toBe(404);

    await app.close();
  });

  it("serves a token-protected quota dashboard with recent usage aggregates", async () => {
    const { store, issued, headers } = createCredentialBackedStore();
    const now = new Date();
    const highUsageCredential = issueAccessCredential({
      subjectId: "subj_high",
      label: "High usage credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now
    });
    store.upsertSubject({
      id: "subj_high",
      label: "A High Usage",
      name: "A High Usage",
      phoneNumber: "+15550001111",
      state: "active",
      createdAt: now
    });
    store.insertAccessCredential(highUsageCredential.record);
    store.createPlan({
      id: "plan_dashboard_v1",
      displayName: "Dashboard Plan",
      scopeAllowlist: ["code"],
      policy: {
        tokensPerMinute: 1000,
        tokensPerDay: 10000,
        tokensPerMonth: 100000,
        maxPromptTokensPerRequest: 2000,
        maxTotalTokensPerRequest: 4000,
        reserveTokensPerRequest: 100,
        missingUsageCharge: "estimate"
      },
      featurePolicy: imageFeaturePolicy(),
      now
    });
    store.grantEntitlement({
      subjectId: "subj_dev",
      planId: "plan_dashboard_v1",
      periodKind: "unlimited",
      now
    });
    store.insertRequestEvent({
      requestId: "req_quota_dashboard_ok",
      credentialId: issued.record.id,
      subjectId: "subj_dev",
      scope: "code",
      sessionId: null,
      upstreamAccountId: "sub_openai_codex_dev",
      provider: "openai-codex",
      startedAt: now,
      durationMs: 20,
      firstByteMs: 8,
      status: "ok",
      errorCode: null,
      rateLimited: false,
      promptTokens: 70,
      completionTokens: 30,
      totalTokens: 100,
      cachedPromptTokens: 0,
      estimatedTokens: 0,
      usageSource: "provider"
    });
    store.insertRequestEvent({
      requestId: "req_quota_dashboard_limited",
      credentialId: issued.record.id,
      subjectId: "subj_dev",
      scope: "code",
      sessionId: null,
      upstreamAccountId: "sub_openai_codex_dev",
      provider: "openai-codex",
      startedAt: now,
      durationMs: 10,
      firstByteMs: 5,
      status: "error",
      errorCode: "rate_limited",
      rateLimited: true,
      promptTokens: 40,
      completionTokens: 0,
      totalTokens: 40,
      cachedPromptTokens: 0,
      estimatedTokens: 40,
      usageSource: "estimate",
      limitKind: "request_day"
    });
    store.insertRequestEvent({
      requestId: "req_quota_dashboard_high_usage",
      credentialId: highUsageCredential.record.id,
      subjectId: "subj_high",
      scope: "code",
      sessionId: null,
      upstreamAccountId: "sub_openai_codex_dev",
      provider: "openai-codex",
      startedAt: now,
      durationMs: 30,
      firstByteMs: 9,
      status: "ok",
      errorCode: null,
      rateLimited: false,
      promptTokens: 450,
      completionTokens: 50,
      totalTokens: 500,
      cachedPromptTokens: 0,
      estimatedTokens: 0,
      usageSource: "provider"
    });
    store.insertRequestEvent({
      requestId: "req_quota_dashboard_auth_noise",
      credentialId: null,
      subjectId: null,
      scope: null,
      sessionId: null,
      upstreamAccountId: null,
      provider: null,
      startedAt: now,
      durationMs: 1,
      firstByteMs: null,
      status: "error",
      errorCode: "missing_credential",
      rateLimited: false,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedPromptTokens: 0,
      estimatedTokens: 0,
      usageSource: "none"
    });
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    clientEventsStore.insertClientMessageEvent({
      id: "cme_quota_dashboard_high_usage",
      eventId: "evt_quota_dashboard_high_usage",
      requestId: "req_quota_dashboard_high_usage",
      credentialId: highUsageCredential.record.id,
      subjectId: "subj_high",
      scope: "code",
      sessionId: "ses_high",
      messageId: "msg_high",
      agent: "research",
      providerId: "medcode",
      modelId: "medcode",
      engine: "agent",
      text: "Patient Alice +15550001111 asks for the latest lupus evidence.",
      textSha256: "a".repeat(64),
      attachmentsJson: "[]",
      appName: "medevidence-desktop",
      appVersion: "1.4.6",
      createdAt: now,
      receivedAt: now
    });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      adminMessagesToken: "admin-messages-token-1234567890",
      logger: false
    });

    const page = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard"
    });
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard.json"
    });
    const ordinaryCredential = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard.json",
      headers
    });
    const data = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard.json?include_inactive=1",
      headers: { authorization: "Bearer admin-messages-token-1234567890" }
    });
    const realtimePage = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard/realtime-token-usage"
    });
    const realtimeUnauthenticated = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard/realtime-token-usage.json"
    });
    const realtimeOrdinaryCredential = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard/realtime-token-usage.json",
      headers
    });
    const realtimeData = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard/realtime-token-usage.json?window_seconds=3600&bucket_seconds=60&limit=10",
      headers: { authorization: "Bearer admin-messages-token-1234567890" }
    });
    const realtimeDataWithAuthNoise = await app.inject({
      method: "GET",
      url: "/gateway/admin/quota-dashboard/realtime-token-usage.json?window_seconds=3600&bucket_seconds=60&limit=10&include_auth_noise=1",
      headers: { authorization: "Bearer admin-messages-token-1234567890" }
    });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("用户套餐与 Token 用量");
    expect(page.body).toContain('id="token"');
    expect(page.body).toContain('id="dailyTokenChart"');
    expect(page.body).toContain("/gateway/admin/quota-dashboard/realtime-token-usage");
    expect(page.body).toContain('placeholder="过滤用户、姓名、手机号、plan、API key prefix"');
    expect(page.body.indexOf('id="search"')).toBeLessThan(page.body.indexOf('id="dailyTokenChart"'));
    expect(page.body).toContain("daily_token_usage");
    expect(page.body).toContain("renderDailyTokenChart");
    expect(page.body).toContain("max-height: calc(100vh - 250px)");
    expect(page.body).toContain("usage_7d.provider_total_tokens");
    expect(page.body).not.toContain("Credential Subject");
    expect(unauthenticated.statusCode).toBe(401);
    expect(ordinaryCredential.statusCode).toBe(401);
    expect(data.statusCode).toBe(200);
    const payload = data.json();
    expect(payload.users.map((user: { user: { id: string } }) => user.user.id).slice(0, 2)).toEqual([
      "subj_high",
      "subj_dev"
    ]);
    expect(payload.users.find((user: { user: { id: string } }) => user.user.id === "subj_dev")).toMatchObject({
      user: {
        id: "subj_dev"
      },
      plan: {
        id: "plan_dashboard_v1"
      },
      usage_today: {
        requests: 2,
        rate_limited: 1,
        provider_total_tokens: 100,
        estimated_tokens: 40
      },
      usage_7d: {
        requests: 2,
        rate_limited: 1,
        provider_total_tokens: 100,
        estimated_tokens: 40
      },
      primary_rate_limit: {
        kind: "request_day",
        count: 1
      }
    });
    expect(payload.users.find((user: { user: { id: string } }) => user.user.id === "subj_high")).toMatchObject({
      usage_7d: {
        provider_total_tokens: 500
      }
    });
    expect(payload.daily_token_window).toMatchObject({
      days: 30
    });
    expect(payload.summary.daily_token_usage).toHaveLength(30);
    expect(
      payload.summary.daily_token_usage.every((row: { date: string }) =>
        /^\d{4}-\d{2}-\d{2}$/.test(row.date)
      )
    ).toBe(true);
    expect(
      payload.summary.daily_token_usage.reduce(
        (sum: number, row: { total_tokens: number }) => sum + row.total_tokens,
        0
      )
    ).toBe(640);
    expect(
      payload.users
        .find((user: { user: { id: string } }) => user.user.id === "subj_dev")
        .daily_token_usage.reduce(
          (sum: number, row: { provider_total_tokens: number; estimated_tokens: number }) =>
            sum + row.provider_total_tokens + row.estimated_tokens,
          0
        )
    ).toBe(140);
    expect(JSON.stringify(payload)).not.toContain(issued.token);
    expect(JSON.stringify(payload)).not.toContain(highUsageCredential.token);
    expect(JSON.stringify(payload)).not.toContain("admin-messages-token-1234567890");
    expect(realtimePage.statusCode).toBe(200);
    expect(realtimePage.headers["content-type"]).toContain("text/html");
    expect(realtimePage.body).toContain("实时 Token 用量监控");
    expect(realtimePage.body).toContain('id="tokenBucketChart"');
    expect(realtimePage.body).toContain('id="includeAuthNoise"');
    expect(realtimePage.body).toContain("include_auth_noise");
    expect(realtimePage.body).toContain("renderBucketChart");
    expect(realtimePage.body).not.toContain("<polyline");
    expect(realtimePage.body).toContain("setInterval");
    expect(realtimeUnauthenticated.statusCode).toBe(401);
    expect(realtimeOrdinaryCredential.statusCode).toBe(401);
    expect(realtimeData.statusCode).toBe(200);
    expect(realtimeDataWithAuthNoise.statusCode).toBe(200);
    const realtimePayload = realtimeData.json();
    const realtimePayloadWithAuthNoise = realtimeDataWithAuthNoise.json();
    expect(realtimePayload.summary).toMatchObject({
      requests: 3,
      total_tokens: 640,
      provider_total_tokens: 600,
      estimated_tokens: 40
    });
    expect(realtimePayloadWithAuthNoise.summary.requests).toBe(4);
    expect(
      realtimePayloadWithAuthNoise.requests.some(
        (request: { request_id: string }) => request.request_id === "req_quota_dashboard_auth_noise"
      )
    ).toBe(true);
    expect(
      realtimePayload.requests.some(
        (request: { request_id: string }) => request.request_id === "req_quota_dashboard_auth_noise"
      )
    ).toBe(false);
    expect(realtimePayload.series.length).toBeGreaterThan(0);
    const firstRealtimeSeriesPoint = realtimePayload.series[0] as {
      bucket_start: string;
      label: string;
    };
    const realtimeBucketMs = realtimePayload.window.bucket_seconds * 1000;
    expect(new Date(firstRealtimeSeriesPoint.bucket_start).getTime() % realtimeBucketMs).toBe(0);
    expect(firstRealtimeSeriesPoint.label).toBe(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        hourCycle: "h23"
      }).format(new Date(firstRealtimeSeriesPoint.bucket_start))
    );
    expect(firstRealtimeSeriesPoint.label).not.toBe(firstRealtimeSeriesPoint.bucket_start.slice(11, 19));
    expect(realtimePayload.privacy).toMatchObject({
      raw_message_text_included: false,
      raw_user_fields_included: false
    });
    const realtimeHighUsage = realtimePayload.requests.find(
      (request: { request_id: string }) => request.request_id === "req_quota_dashboard_high_usage"
    );
    expect(realtimeHighUsage).toMatchObject({
      user: {
        alias: expect.stringMatching(/^user-[a-f0-9]{8}$/)
      },
      credential: {
        alias: expect.stringMatching(/^key-[a-f0-9]{8}$/)
      },
      message: {
        available: true,
        alias: expect.stringMatching(/^msg-[a-f0-9]{8}$/),
        char_count: 62,
        attachments_count: 0
      },
      token_usage: {
        prompt_tokens: 450,
        completion_tokens: 50,
        total_tokens: 500,
        provider_total_tokens: 500
      }
    });
    expect(realtimeHighUsage.message.preview).toContain("消息指纹");
    const realtimeJson = JSON.stringify(realtimePayload);
    expect(realtimeJson).not.toContain("Patient Alice");
    expect(realtimeJson).not.toContain("+15550001111");
    expect(realtimeJson).not.toContain("A High Usage");
    expect(realtimeJson).not.toContain("Credential Subject");
    expect(realtimeJson).not.toContain(issued.token);
    expect(realtimeJson).not.toContain(highUsageCredential.token);
    expect(realtimeJson).not.toContain("admin-messages-token-1234567890");

    await app.close();
  });

  it("writes client diagnostic events to the dedicated store without request observation", async () => {
    const { store, issued, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_write_1",
        category: "agent_turn",
        action: "turn",
        status: "queued",
        tool_call_id: "toolu_1",
        method: "POST",
        path: "/session/:sessionID/prompt_async",
        mono_ms: 12345.25,
        duration_ms: 1530,
        http_status: 204,
        metadata: {
          count: 3,
          source: "prefetch",
          provider_id: "medcode",
          model_id: "gpt-5.5",
          instance_id: "inst_1",
          process: "main"
        }
      })
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ok: true,
      event_id: "diag_write_1",
      duplicate: false
    });
    const stored = clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_write_1");
    expect(stored).toMatchObject({
      eventId: "diag_write_1",
      credentialId: issued.record.id,
      subjectId: "subj_dev",
      scope: "code",
      sessionId: "ses_1",
      messageId: "msg_1",
      toolCallId: "toolu_1",
      providerId: "medcode",
      modelId: "gpt-5.5",
      category: "agent_turn",
      action: "turn",
      status: "queued",
      method: "POST",
      path: "/session/:sessionID/prompt_async",
      monoMs: 12345.25,
      durationMs: 1530,
      httpStatus: 204,
      appName: "medevidence-desktop",
      appVersion: "1.4.6"
    });
    expect(JSON.parse(stored?.metadataJson ?? "{}")).toEqual({
      count: 3,
      source: "prefetch",
      provider_id: "medcode",
      model_id: "gpt-5.5",
      instance_id: "inst_1",
      process: "main"
    });
    expect(store.listRequestEvents()).toEqual([]);

    await app.close();
  });

  it("links diagnostics without message ids to the latest message in the session", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const message = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_link_1",
        session_id: "ses_link_1",
        message_id: "msg_link_1",
        created_at: "2026-04-29T10:00:00.000Z",
        text: "Create an academic PPT."
      })
    });
    expect(message.statusCode).toBe(201);

    const diagnostic = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_link_1",
        session_id: null,
        message_id: null,
        created_at: "2026-04-29T10:00:05.000Z",
        category: "provider_stream",
        action: "request",
        status: "started",
        metadata: {
          session_id: "ses_link_1",
          provider_id: "medcode"
        }
      })
    });
    expect(diagnostic.statusCode, diagnostic.body).toBe(201);

    const stored = clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_link_1");
    expect(stored).toMatchObject({
      sessionId: "ses_link_1",
      messageId: "msg_link_1",
      providerId: "medcode",
      category: "provider_stream"
    });
    expect(JSON.parse(stored?.metadataJson ?? "{}")).toMatchObject({
      diagnostic_link: {
        source: "inferred_latest_session_message",
        message_id: "msg_link_1"
      }
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_link_1",
        session_id: null,
        message_id: null,
        created_at: "2026-04-29T10:00:05.000Z",
        category: "provider_stream",
        action: "request",
        status: "started",
        metadata: {
          session_id: "ses_link_1",
          provider_id: "medcode"
        }
      })
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true });

    await app.close();
  });

  it("backfills and reassigns inferred diagnostic message links when messages arrive late", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const earlyDiagnostic = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_late_message_1",
        session_id: "ses_late_1",
        message_id: null,
        created_at: "2026-04-29T10:00:05.000Z",
        category: "provider_stream",
        action: "request",
        status: "started",
        metadata: {}
      })
    });
    expect(earlyDiagnostic.statusCode).toBe(201);
    expect(
      clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_late_message_1")
    ).toMatchObject({
      sessionId: "ses_late_1",
      messageId: null
    });

    const lateMessage = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_late_1",
        session_id: "ses_late_1",
        message_id: "msg_late_1",
        created_at: "2026-04-29T10:00:00.000Z",
        text: "Late uploaded prompt."
      })
    });
    expect(lateMessage.statusCode).toBe(201);
    expect(
      clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_late_message_1")
    ).toMatchObject({
      sessionId: "ses_late_1",
      messageId: "msg_late_1"
    });

    await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_old_1",
        session_id: "ses_reassign_1",
        message_id: "msg_old_1",
        created_at: "2026-04-29T10:00:00.000Z",
        text: "Previous prompt."
      })
    });
    await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_reassign_1",
        session_id: "ses_reassign_1",
        message_id: null,
        created_at: "2026-04-29T10:00:10.000Z",
        category: "provider_stream",
        action: "request",
        status: "started",
        metadata: {}
      })
    });
    expect(clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_reassign_1")).toMatchObject({
      messageId: "msg_old_1"
    });

    await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_new_1",
        session_id: "ses_reassign_1",
        message_id: "msg_new_1",
        created_at: "2026-04-29T10:00:05.000Z",
        text: "Prompt uploaded after its diagnostics."
      })
    });
    expect(clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_reassign_1")).toMatchObject({
      messageId: "msg_new_1"
    });

    await app.close();
  });

  it("does not infer message links for background session diagnostics", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_background_1",
        session_id: "ses_background_1",
        message_id: "msg_background_1",
        created_at: "2026-04-29T10:00:00.000Z"
      })
    });
    const diagnostic = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_background_1",
        session_id: "ses_background_1",
        message_id: null,
        created_at: "2026-04-29T10:00:05.000Z",
        category: "http",
        action: "GET /session",
        status: "ok",
        metadata: {}
      })
    });

    expect(diagnostic.statusCode).toBe(201);
    expect(clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_background_1")).toMatchObject({
      sessionId: "ses_background_1",
      messageId: null,
      category: "http"
    });

    await app.close();
  });

  it("preserves MedEvidence tool audit diagnostic metadata including raw text fields", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });
    const originalUserText = "original medical analysis prompt ".repeat(1200);
    const medevidenceToolText = "extract evidence question and avoid file/code work ".repeat(900);
    const metadata = {
      original_user_text: originalUserText,
      medevidence_tool_text: medevidenceToolText,
      question_hash: "q".repeat(64),
      question_length: medevidenceToolText.length,
      original_user_hash: "o".repeat(64),
      original_user_length: originalUserText.length,
      question_same_as_user: false,
      question_derived: true,
      medevidence_question_guard: {
        outcome: "accepted",
        rejected_spans: 1
      },
      guard_reject_count: 1,
      tool_outcome: "called"
    };
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeGreaterThan(16 * 1024);

    const response = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_medevidence_audit_1",
        category: "medevidence",
        action: "tool_audit",
        status: "ok",
        metadata
      })
    });

    expect(response.statusCode).toBe(201);
    const stored = clientEventsStore.getClientDiagnosticEvent(
      "subj_dev",
      "diag_medevidence_audit_1"
    );
    expect(JSON.parse(stored?.metadataJson ?? "{}")).toMatchObject(metadata);

    await app.close();
  });

  it("accepts Phase 1A client diagnostic categories and statuses", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });
    const categories = [
      "agent_turn",
      "provider_stream",
      "tool",
      "fs",
      "sidecar",
      "renderer",
      "user_action",
      "system",
      "storage",
      "diagnostic_upload"
    ];

    for (const [index, category] of categories.entries()) {
      const status = index % 2 === 0 ? "queued" : "dropped";
      const response = await app.inject({
        method: "POST",
        url: "/gateway/client-events/diagnostics",
        headers,
        payload: clientDiagnosticPayload({
          event_id: `diag_phase1a_${index}`,
          category,
          action: "event",
          status
        })
      });

      expect(response.statusCode).toBe(201);
      expect(
        clientEventsStore.getClientDiagnosticEvent("subj_dev", `diag_phase1a_${index}`)
      ).toMatchObject({ category, status });
    }

    await app.close();
  });

  it("validates client diagnostic metadata before storage", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const forbidden = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_forbidden_1",
        metadata: {
          authorization: "Bearer should-not-store"
        }
      })
    });
    const invalidStatus = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_status_1",
        status: "waiting"
      })
    });
    const sensitivePath = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_path_1",
        path: "/v1/chat/completions?api_key=should-not-store"
      })
    });
    const sensitiveError = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_error_1",
        error_message: `Authorization: Bearer ${"x".repeat(22)}`
      })
    });
    const sensitiveMetadataValue = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_metadata_value_1",
        metadata: {
          detail: "access_token=should-not-store"
        }
      })
    });

    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.json().error.message).toContain("authorization is not allowed");
    expect(invalidStatus.statusCode).toBe(400);
    expect(invalidStatus.json().error.message).toContain("status must be");
    expect(sensitivePath.statusCode).toBe(400);
    expect(sensitivePath.json().error.message).toContain("query string");
    expect(sensitiveError.statusCode).toBe(400);
    expect(sensitiveError.json().error.message).toContain("credentials or secrets");
    expect(sensitiveMetadataValue.statusCode).toBe(400);
    expect(sensitiveMetadataValue.json().error.message).toContain("metadata.detail is not allowed");
    expect(clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_forbidden_1")).toBeNull();
    expect(clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_status_1")).toBeNull();
    expect(clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_path_1")).toBeNull();
    expect(clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_error_1")).toBeNull();
    expect(clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_metadata_value_1")).toBeNull();

    await app.close();
  });

  it("keeps client diagnostic event idempotency immutable", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });
    const payload = clientDiagnosticPayload({
      event_id: "diag_idempotent_1",
      duration_ms: 120,
      metadata: { count: 1 }
    });

    const created = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({
        event_id: "diag_idempotent_1",
        duration_ms: 121,
        metadata: { count: 1 }
      })
    });

    expect(created.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      ok: true,
      event_id: "diag_idempotent_1",
      duplicate: true
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
    expect(
      clientEventsStore.getClientDiagnosticEvent("subj_dev", "diag_idempotent_1")?.durationMs
    ).toBe(120);

    await app.close();
  });

  it("keeps client message event idempotency immutable", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });
    const payload = clientMessagePayload({
      event_id: "evt_idempotent_1",
      text: "first text"
    });

    const created = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_idempotent_1",
        text: "changed text"
      })
    });

    expect(created.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      ok: true,
      event_id: "evt_idempotent_1",
      duplicate: true
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
    expect(clientEventsStore.getClientMessageEvent("subj_dev", "evt_idempotent_1")?.text).toBe(
      "first text"
    );

    await app.close();
  });

  it("validates client message text byte length and attachment metadata", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const oversized = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_oversized_1",
        text: "a".repeat(64 * 1024 + 1)
      })
    });
    const attachmentContent = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_attachment_1",
        attachments: [
          {
            type: "file",
            filename: "report.pdf",
            content: "raw body"
          }
        ]
      })
    });

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe("invalid_request");
    expect(attachmentContent.statusCode).toBe(400);
    expect(attachmentContent.json().error.message).toContain("content is not allowed");
    expect(clientEventsStore.getClientMessageEvent("subj_dev", "evt_oversized_1")).toBeNull();
    expect(clientEventsStore.getClientMessageEvent("subj_dev", "evt_attachment_1")).toBeNull();

    await app.close();
  });

  it("uses credential auth and an independent rate limit for client message events", async () => {
    const { store, headers } = createCredentialBackedStore({
      requestsPerMinute: 1,
      requestsPerDay: null,
      concurrentRequests: null
    });
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      clientEventsRatePolicy: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: null
      },
      logger: false
    });

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      payload: clientMessagePayload()
    });
    const firstClientEvent = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({ event_id: "evt_limit_1" })
    });
    const firstModelRoute = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    const secondClientEvent = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({ event_id: "evt_limit_2" })
    });
    const secondModelRoute = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("missing_credential");
    expect(firstClientEvent.statusCode).toBe(201);
    expect(firstModelRoute.statusCode).toBe(200);
    expect(secondClientEvent.statusCode).toBe(429);
    expect(secondClientEvent.json().error.code).toBe("rate_limited");
    expect(secondModelRoute.statusCode).toBe(429);

    await app.close();
  });

  it("uses separate ingest rate limit buckets for messages and diagnostics", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      clientEventsRatePolicy: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: null
      },
      logger: false
    });

    const firstDiagnostic = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({ event_id: "diag_bucket_1" })
    });
    const messageAfterDiagnostic = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({ event_id: "evt_bucket_1" })
    });
    const secondDiagnostic = await app.inject({
      method: "POST",
      url: "/gateway/client-events/diagnostics",
      headers,
      payload: clientDiagnosticPayload({ event_id: "diag_bucket_2" })
    });

    expect(firstDiagnostic.statusCode).toBe(201);
    expect(messageAfterDiagnostic.statusCode).toBe(201);
    expect(secondDiagnostic.statusCode).toBe(429);
    expect(secondDiagnostic.json().error.code).toBe("rate_limited");

    await app.close();
  });

  it("rejects dev auth mode when NODE_ENV is production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        buildGateway({
          accessToken: "secret",
          provider: new FakeProvider(),
          logger: false
        })
      ).toThrow("Dev auth mode is not allowed");
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it("validates production runtime environment before listening", () => {
    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home"
      })
    ).not.toThrow();

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home",
        GATEWAY_DEV_ACCESS_TOKEN: "leftover-dev-token"
      })
    ).toThrow("Production runtime must not set GATEWAY_DEV_ACCESS_TOKEN");

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home"
      })
    ).toThrow("Production runtime requires GATEWAY_AUTH_MODE=credential");

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home",
        GATEWAY_UPSTREAM_V2_BASE_URL: "https://v2.internal"
      })
    ).toThrow("GATEWAY_UPSTREAM_V2_BASE_URL and GATEWAY_UPSTREAM_V2_TOKEN together");

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db"
      })
    ).toThrow("Production runtime requires CODEX_HOME or GATEWAY_UPSTREAM_ACCOUNTS_JSON");

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        GATEWAY_UPSTREAM_ACCOUNTS_JSON: "/var/lib/codex-gateway/upstream-accounts.json"
      })
    ).not.toThrow();

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home",
        GATEWAY_BILLING_ADMIN_TOKEN: "billing-admin-token-1234567890"
      })
    ).toThrow("Production billing admin API requires GATEWAY_API_KEY_ENCRYPTION_SECRET");

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home",
        GATEWAY_BILLING_ADMIN_TOKEN: "billing-admin-token-1234567890",
        GATEWAY_API_KEY_ENCRYPTION_SECRET: "billing-subject-secret-1234567890"
      })
    ).not.toThrow();
  });

  it("validates configured upstream reasoning effort", async () => {
    const previousReasoningEffort = process.env.MEDCODE_UPSTREAM_REASONING_EFFORT;
    process.env.MEDCODE_UPSTREAM_REASONING_EFFORT = "high";
    const app = buildGateway({
      accessToken: "secret",
      logger: false
    });
    await app.close();

    process.env.MEDCODE_UPSTREAM_REASONING_EFFORT = "fast";
    try {
      expect(() =>
        buildGateway({
          accessToken: "secret",
          logger: false
        })
      ).toThrow("MEDCODE_UPSTREAM_REASONING_EFFORT must be minimal, low, medium, high, or xhigh.");
    } finally {
      if (previousReasoningEffort === undefined) {
        delete process.env.MEDCODE_UPSTREAM_REASONING_EFFORT;
      } else {
        process.env.MEDCODE_UPSTREAM_REASONING_EFFORT = previousReasoningEffort;
      }
    }
  });

  it("requires bearer auth for status", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/gateway/status"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("missing_credential");
    await app.close();
  });

  it("exposes an OpenAI-compatible model list", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer secret" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "medcode",
          object: "model",
          created: 0,
          owned_by: "medcode",
          context_window: 400000,
          max_context_window: 400000,
          max_output_tokens: 128000
        }
      ]
    });

    await app.close();
  });

  it("exposes enabled public model registry limits without changing the default medcode limit", async () => {
    await withTemporaryEnv(
      {
        MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
      },
      async () => {
        const app = buildGateway({
          accessToken: "secret",
          provider: new FakeProvider(),
          logger: false
        });

        const response = await app.inject({
          method: "GET",
          url: "/v1/models",
          headers: { authorization: "Bearer secret" }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data).toEqual([
          expect.objectContaining({
            id: "medcode",
            context_window: 400000,
            max_context_window: 400000,
            max_output_tokens: 128000
          }),
          expect.objectContaining({
            id: "pro",
            context_window: 200000,
            max_context_window: 200000,
            max_output_tokens: 128000
          }),
          expect.objectContaining({
            id: "standard",
            context_window: 200000,
            max_context_window: 200000,
            max_output_tokens: 128000
          })
        ]);

        await app.close();
      }
    );
  });

  it("keeps medcode prompt bytes unchanged when OpenRouter models are configured", async () => {
    await withTemporaryEnv(
      {
        MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
      },
      async () => {
        const provider = new FakeProvider([
          { type: "message_delta", text: "ok" },
          { type: "completed", providerSessionRef: "provider_thread_1" }
        ]);
        const app = buildGateway({
          accessToken: "secret",
          provider,
          logger: false
        });

        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: "Bearer secret" },
          payload: {
            model: "medcode",
            messages: [{ role: "user", content: "Say ok." }]
          }
        });

        expect(response.statusCode).toBe(200);
        expect(provider.messages).toHaveLength(1);
        expect(provider.messages[0].message).toBe(
          [
            "Continue the following conversation as the assistant.",
            "Preserve the user's intent and answer directly.",
            "",
            "<conversation>",
            "[user]",
            "Say ok.",
            "</conversation>"
          ].join("\n")
        );
        expect(provider.messages[0].message).not.toContain("OpenRouter");
        expect(provider.messages[0].message).not.toContain("You are MedCode");

        await app.close();
      }
    );
  });

  it("rejects unknown OpenAI chat completion models", async () => {
    const provider = new FakeProvider();
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: "Model 'gpt-4' does not exist.",
        type: "invalid_request_error",
        code: "model_not_found",
        param: null
      }
    });
    expect(provider.messages).toHaveLength(0);

    await app.close();
  });

  it("does not let medcode_models restrict any enabled public chat model", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server = await startOpenAICompatibleSseServer(async (_request, body, response) => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "or-ok" } }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 2,
            total_tokens: 9,
            completion_tokens_details: { reasoning_tokens: 0 }
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const { store, headers } = createModelEntitledStore(["standard"]);
          const provider = new FakeProvider([
            { type: "message_delta", text: "max-ok" },
            { type: "completed", providerSessionRef: "provider_thread_1" }
          ]);
          const app = buildGateway({
            authMode: "credential",
            provider,
            sessionStore: store,
            observationStore: store,
            logger: false
          });

          try {
            const medcode = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "medcode",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });
            const pro = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "pro",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });

            expect(medcode.statusCode).toBe(200);
            expect(pro.statusCode).toBe(200);
            expect(medcode.json().choices[0].message.content).toBe("max-ok");
            expect(pro.json().choices[0].message.content).toBe("or-ok");
            expect(provider.messages).toHaveLength(1);
            expect(captured.map((body) => body.model)).toEqual(["z-ai/glm-5.2"]);
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("allows all enabled public models when an old entitlement snapshot lacks medcode_models", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server = await startOpenAICompatibleSseServer(async (_request, body, response) => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "legacy-openrouter-ok" } }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 2,
            total_tokens: 9,
            completion_tokens_details: { reasoning_tokens: 0 }
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const { store, headers } = createModelEntitledStore(null);
          const provider = new FakeProvider([
            { type: "message_delta", text: "legacy-codex-ok" },
            { type: "completed", providerSessionRef: "provider_thread_1" }
          ]);
          const app = buildGateway({
            authMode: "credential",
            provider,
            sessionStore: store,
            logger: false
          });

          try {
            const medcode = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "medcode",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });
            const standard = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "standard",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });
            const pro = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "pro",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });

            expect(medcode.statusCode).toBe(200);
            expect(standard.statusCode).toBe(200);
            expect(pro.statusCode).toBe(200);
            expect(medcode.json().choices[0].message.content).toBe("legacy-codex-ok");
            expect(standard.json().choices[0].message.content).toBe("legacy-openrouter-ok");
            expect(pro.json().choices[0].message.content).toBe("legacy-openrouter-ok");
            expect(provider.messages).toHaveLength(1);
            expect(captured.map((body) => body.model)).toEqual([
              "deepseek/deepseek-v4-pro",
              "z-ai/glm-5.2"
            ]);
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("allows OpenRouter public models for issued legacy keys without entitlement history", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server = await startOpenAICompatibleSseServer(async (_request, body, response) => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "legacy-key-openrouter-ok" } }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 2,
            total_tokens: 9,
            completion_tokens_details: { reasoning_tokens: 0 }
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const store = createSqliteStore({ path: ":memory:" });
          const issued = issueAccessCredential({
            subjectId: "subj_dev",
            label: "Legacy credential",
            scope: "code",
            expiresAt: new Date("2030-02-01T00:00:00Z"),
            now: new Date("2026-01-01T00:00:00Z")
          });
          store.upsertSubject({
            id: "subj_dev",
            label: "Legacy Subject",
            state: "active",
            createdAt: new Date("2026-01-01T00:00:00Z")
          });
          store.insertAccessCredential(issued.record);
          const app = buildGateway({
            authMode: "credential",
            provider: new FakeProvider(),
            sessionStore: store,
            logger: false
          });

          try {
            const pro = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers: { authorization: `Bearer ${issued.token}` },
              payload: {
                model: "pro",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });

            expect(pro.statusCode).toBe(200);
            expect(pro.json().choices[0].message.content).toBe("legacy-key-openrouter-ok");
            expect(captured.map((body) => body.model)).toEqual(["z-ai/glm-5.2"]);
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("routes OpenRouter public models through independent adapter instances", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server = await startOpenAICompatibleSseServer(async (_request, body, response) => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "or-ok" } }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 2,
            total_tokens: 9,
            completion_tokens_details: { reasoning_tokens: 0 }
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const { store, headers } = createModelEntitledStore(["standard", "pro"]);
          const codexProvider = new FakeProvider();
          const codexAccount = testUpstreamAccount("codex-pro-1");
          const app = buildGateway({
            authMode: "credential",
            sessionStore: store,
            observationStore: store,
            upstreamAccounts: [
              {
                upstreamAccount: codexAccount,
                provider: codexProvider,
                maxConcurrent: 1
              }
            ],
            logger: false
          });

          try {
            const standard = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "standard",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });
            const pro = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "pro",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });

            expect(standard.statusCode).toBe(200);
            expect(pro.statusCode).toBe(200);
            expect(codexProvider.messages).toHaveLength(0);
            expect(captured.map((body) => body.model)).toEqual([
              "deepseek/deepseek-v4-pro",
              "z-ai/glm-5.2"
            ]);
            expect(
              captured.every(
                (body) => body.reasoning && (body.reasoning as { effort: string }).effort === "none"
              )
            ).toBe(true);
            expect(standard.json().usage).toMatchObject({
              completion_tokens_details: { reasoning_tokens: 0 }
            });
            expect(store.getUpstreamAccount("openrouter-main")).toBeNull();
            expect(store.getUpstreamAccount("codex-pro-1")).toMatchObject({
              state: "active",
              cooldownUntil: null
            });
            expect(store.listRequestEvents({ limit: 5 })).toEqual([
              expect.objectContaining({
                publicModelId: "pro",
                upstreamRuntime: "openrouter",
                upstreamModel: "z-ai/glm-5.2",
                upstreamAccountId: "openrouter-main",
                provider: "openrouter",
                status: "ok"
              }),
              expect.objectContaining({
                publicModelId: "standard",
                upstreamRuntime: "openrouter",
                upstreamModel: "deepseek/deepseek-v4-pro",
                upstreamAccountId: "openrouter-main",
                provider: "openrouter",
                status: "ok"
              })
            ]);
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("uses native OpenRouter tools for Pro and Standard instead of strict JSON prompts", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server = await startOpenAICompatibleSseServer(async (_request, body, response) => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_native_file",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: '{"path":"t-test.html","content":"<html></html>"}'
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 8,
            total_tokens: 58
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const { store, headers } = createModelEntitledStore(["pro"]);
          const app = buildGateway({
            authMode: "credential",
            provider: new FakeProvider(),
            sessionStore: store,
            observationStore: store,
            logger: false
          });

          try {
            const response = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "pro",
                messages: [
                  {
                    role: "user",
                    content:
                      "Create an interactive statistics t-test HTML file with animation, links, and navigation."
                  }
                ],
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "write_file",
                      parameters: {
                        type: "object",
                        properties: {
                          path: { type: "string" },
                          content: { type: "string" }
                        },
                        required: ["path", "content"],
                        additionalProperties: false
                      }
                    }
                  }
                ]
              }
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().choices[0]).toMatchObject({
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_native_file",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: '{"path":"t-test.html","content":"<html></html>"}'
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            });
            expect(response.json().usage).toMatchObject({
              prompt_tokens: 50,
              completion_tokens: 8,
              total_tokens: 58
            });
            expect(captured).toHaveLength(1);
            expect(captured[0]).toMatchObject({
              model: "z-ai/glm-5.2",
              tools: [
                {
                  type: "function",
                  function: { name: "write_file" }
                }
              ],
              tool_choice: "auto"
            });
            const messages = captured[0].messages as Array<{ role: string; content: string }>;
            expect(messages[1].content).toContain("callable tools through the API");
            expect(messages[1].content).not.toContain("strict client-defined tools mode");
            expect(store.listRequestEvents({ limit: 1 })[0]).toMatchObject({
              publicModelId: "pro",
              upstreamRuntime: "openrouter",
              status: "ok"
            });
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("retries native OpenRouter auto tools once when the model only acknowledges an action", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server = await startOpenAICompatibleSseServer(async (_request, body, response) => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (captured.length === 1) {
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "I will create the HTML file." } }],
            usage: {
              prompt_tokens: 40,
              completion_tokens: 7,
              total_tokens: 47
            }
          })}\n\n`
        );
        response.end("data: [DONE]\n\n");
        return;
      }

      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_required_file",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: '{"path":"t-test.html","content":"<html></html>"}'
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: {
            prompt_tokens: 41,
            completion_tokens: 8,
            total_tokens: 49
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const { store, headers } = createModelEntitledStore(["pro"]);
          const app = buildGateway({
            authMode: "credential",
            provider: new FakeProvider(),
            sessionStore: store,
            observationStore: store,
            logger: false
          });

          try {
            const response = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "pro",
                stream: true,
                messages: [
                  {
                    role: "user",
                    content:
                      "Create an interactive statistics t-test HTML file with animation, links, and navigation."
                  }
                ],
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "write_file",
                      parameters: {
                        type: "object",
                        properties: {
                          path: { type: "string" },
                          content: { type: "string" }
                        },
                        required: ["path", "content"],
                        additionalProperties: false
                      }
                    }
                  }
                ]
              }
            });

            expect(response.statusCode).toBe(200);
            expect(response.payload).not.toContain("I will create the HTML file.");
            const frames = parseOpenAISseData(response.payload);
            expect(frames[1]).toMatchObject({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_required_file",
                        type: "function",
                        function: {
                          name: "write_file",
                          arguments: '{"path":"t-test.html","content":"<html></html>"}'
                        }
                      }
                    ]
                  }
                }
              ]
            });
            expect(frames[2]).toMatchObject({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: 81,
                completion_tokens: 15,
                total_tokens: 96
              }
            });
            expect(captured.map((body) => body.tool_choice)).toEqual(["auto", "required"]);
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("rejects undeclared native OpenRouter tool calls", async () => {
    const server = await startOpenAICompatibleSseServer(async (_request, _body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_bad_tool",
                    type: "function",
                    function: {
                      name: "shell",
                      arguments: '{"command":"ls"}'
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const { store, headers } = createModelEntitledStore(["pro"]);
          const app = buildGateway({
            authMode: "credential",
            provider: new FakeProvider(),
            sessionStore: store,
            observationStore: store,
            logger: false
          });

          try {
            const response = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "pro",
                messages: [{ role: "user", content: "Create a file." }],
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "write_file",
                      parameters: {
                        type: "object",
                        properties: {
                          path: { type: "string" },
                          content: { type: "string" }
                        },
                        required: ["path", "content"],
                        additionalProperties: false
                      }
                    }
                  }
                ]
              }
            });

            expect(response.statusCode).toBe(502);
            expect(response.json().error).toMatchObject({
              code: "tool_call_validation_failed"
            });
            expect(response.json().error.message).toContain("was not declared");
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("rejects native OpenRouter tool arguments that fail the declared schema", async () => {
    const server = await startOpenAICompatibleSseServer(async (_request, _body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_bad_args",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: '{"path":123,"content":"<html></html>"}'
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const { store, headers } = createModelEntitledStore(["pro"]);
          const app = buildGateway({
            authMode: "credential",
            provider: new FakeProvider(),
            sessionStore: store,
            observationStore: store,
            logger: false
          });

          try {
            const response = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "pro",
                messages: [{ role: "user", content: "Create a file." }],
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "write_file",
                      parameters: {
                        type: "object",
                        properties: {
                          path: { type: "string" },
                          content: { type: "string" }
                        },
                        required: ["path", "content"],
                        additionalProperties: false
                      }
                    }
                  }
                ]
              }
            });

            expect(response.statusCode).toBe(502);
            expect(response.json().error).toMatchObject({
              code: "tool_call_validation_failed"
            });
            expect(response.json().error.message).toContain("must be string");
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("does not convert OpenRouter auth failures into Codex reauth or cooldown", async () => {
    const server = await startOpenAICompatibleSseServer(async (_request, _body, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });

    try {
      await withTemporaryEnv(
        {
          MEDCODE_OPENROUTER_API_KEY: "sk-test-redacted",
          MEDCODE_OPENROUTER_BASE_URL: server.baseUrl,
          MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(publicModelRegistryFixture())
        },
        async () => {
          const { store, headers } = createModelEntitledStore(["standard"]);
          const codexProvider = new FakeProvider();
          const codexAccount = testUpstreamAccount("codex-pro-1");
          const app = buildGateway({
            authMode: "credential",
            sessionStore: store,
            observationStore: store,
            upstreamAccounts: [
              {
                upstreamAccount: codexAccount,
                provider: codexProvider,
                maxConcurrent: 1
              }
            ],
            logger: false
          });

          try {
            const response = await app.inject({
              method: "POST",
              url: "/v1/chat/completions",
              headers,
              payload: {
                model: "standard",
                messages: [{ role: "user", content: "Say ok." }]
              }
            });

            expect(response.statusCode).toBe(503);
            expect(response.json().error.code).toBe("upstream_unavailable");
            expect(codexProvider.messages).toHaveLength(0);
            expect(codexAccount).toMatchObject({
              state: "active",
              cooldownUntil: null
            });
            expect(store.listRequestEvents({ limit: 1 })).toEqual([
              expect.objectContaining({
                publicModelId: "standard",
                upstreamRuntime: "openrouter",
                upstreamModel: "deepseek/deepseek-v4-pro",
                upstreamAccountId: "openrouter-main",
                provider: "openrouter",
                status: "error",
                errorCode: "upstream_unavailable"
              })
            ]);
          } finally {
            await app.close();
          }
        }
      );
    } finally {
      await server.close();
    }
  });

  it("creates non-streaming OpenAI chat completions from messages", async () => {
    const provider = new FakeProvider([
      { type: "message_delta", text: "hello" },
      { type: "message_delta", text: " world" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [
          { role: "developer", content: "Answer briefly." },
          { role: "user", content: "Say hello." }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "medcode",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hello world"
          },
          finish_reason: "stop"
        }
      ],
      usage: null
    });
    expect(response.json().id).toMatch(/^chatcmpl_/);
    expect(provider.messages[0].session.id).toMatch(/^sess_stateless_/);
    expect(provider.messages[0].message).toContain("[developer]");
    expect(provider.messages[0].message).toContain("Answer briefly.");
    expect(provider.messages[0].message).toContain("[user]");
    expect(provider.messages[0].message).toContain("Say hello.");

    await app.close();
  });

  it("omits assistant text content when a tool call is returned", async () => {
    const provider = new FakeProvider([
      {
        type: "tool_call",
        callId: "call_1",
        name: "shell",
        arguments: { command: "ls" }
      },
      {
        type: "message_delta",
        text: "I tried to run ls but the server sandbox failed."
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "List files." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "shell",
              arguments: '{"command":"ls"}'
            }
          }
        ]
      },
      finish_reason: "tool_calls"
    });

    await app.close();
  });

  it("streams OpenAI chat completion chunks", async () => {
    const provider = new FakeProvider([
      { type: "message_delta", text: "hello" },
      { type: "message_delta", text: " world" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "Say hello." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expectRequestIdHeader(response);
    expect(response.payload).toContain('"object":"chat.completion.chunk"');
    expect(response.payload).toContain('"delta":{"role":"assistant"}');
    expect(response.payload).toContain('"delta":{"content":"hello"}');
    expect(response.payload).toContain('"finish_reason":"stop"');
    expect(response.payload).toContain("data: [DONE]");

    await app.close();
  });

  it("returns OpenAI tool calls and usage for non-streaming chat completions", async () => {
    const provider = new FakeProvider([
      {
        type: "tool_call",
        callId: "call_1",
        name: "bash",
        arguments: { command: "ls" }
      },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          cachedPromptTokens: 4
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "List files." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "medcode",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"command":"ls"}'
                }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: {
          cached_tokens: 4
        }
      }
    });

    await app.close();
  });

  it("returns strict client-defined tool calls for non-streaming chat completions", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "medevidence",
              arguments: {
                question: "What evidence supports aspirin after MI?"
              }
            }
          ]
        })
      },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 20,
          completionTokens: 3,
          totalTokens: 23
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Answer with evidence." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              description: "Answer a medical evidence question.",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            type: "function",
            function: {
              name: "medevidence",
              arguments: '{"question":"What evidence supports aspirin after MI?"}'
            }
          }
        ]
      },
      finish_reason: "tool_calls"
    });
    expect(response.json().choices[0].message.tool_calls[0].id).toMatch(/^call_/);
    expect(provider.messages[0].message).toContain("strict client-defined tools mode");
    expect(provider.messages[0].message).toContain("medevidence");

    await app.close();
  });

  it("accepts draft 2020-12 schemas for strict client-defined tools", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "bash",
              arguments: {
                command: "ls"
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "List files in current dir via a tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command.",
              parameters: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            type: "function",
            function: {
              name: "bash",
              arguments: '{"command":"ls"}'
            }
          }
        ]
      },
      finish_reason: "tool_calls"
    });
    expect(provider.messages).toHaveLength(1);

    await app.close();
  });

  it("keeps draft-07 schemas accepted for strict client-defined tools", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "search",
              arguments: {
                query: "heart failure"
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Search evidence." }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                $schema: "http://json-schema.org/draft-07/schema#",
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].finish_reason).toBe("tool_calls");
    expect(
      JSON.parse(response.json().choices[0].message.tool_calls[0].function.arguments)
    ).toEqual({
      query: "heart failure"
    });

    await app.close();
  });

  it("rejects undeclared tools in strict client-defined tool mode", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "shell",
              arguments: {
                command: "ls"
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use a medical evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({
      code: "tool_call_validation_failed",
      type: "server_error"
    });
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[1].message).toContain("previous output was invalid");

    await app.close();
  });

  it("rejects strict tool arguments that do not match the client schema", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "medevidence",
              arguments: {
                question: 123
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use a medical evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("tool_call_validation_failed");
    expect(response.json().error.message).toContain("must be string");

    await app.close();
  });

  it("falls back to a plain assistant message for auto strict tools plain text", async () => {
    const provider = new FakeProvider([
      { type: "message_delta", text: "Here is a simulated dataset analysis." },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 5,
          completionTokens: 4,
          totalTokens: 9
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Continue the analysis without tools." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: "Here is a simulated dataset analysis."
      },
      finish_reason: "stop"
    });
    expect(response.json().choices[0].message.tool_calls).toBeUndefined();
    expect(response.json().usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18
    });
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[1].message).toContain("previous output was invalid");

    await app.close();
  });

  it("does not fallback for malformed strict tool-call output", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: '{"type":"tool_calls","tool_calls":[{"name":"medevidence","arguments":'
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use a medical evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({
      code: "tool_call_validation_failed",
      message: "Expected valid JSON object output."
    });
    expect(provider.messages).toHaveLength(2);

    await app.close();
  });

  it("does not fallback for required or named tool_choice plain text", async () => {
    const toolChoices = [
      "required",
      {
        type: "function",
        function: { name: "medevidence" }
      }
    ];

    for (const toolChoice of toolChoices) {
      const provider = new FakeProvider([
        { type: "message_delta", text: "I can answer directly without a tool." },
        { type: "completed", providerSessionRef: "provider_thread_1" }
      ]);
      const app = buildGateway({
        accessToken: "secret",
        provider,
        logger: false
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer secret" },
        payload: {
          model: "medcode",
          messages: [{ role: "user", content: "Use the evidence tool." }],
          tool_choice: toolChoice,
          tools: [
            {
              type: "function",
              function: {
                name: "medevidence",
                parameters: {
                  type: "object",
                  properties: { question: { type: "string" } },
                  required: ["question"],
                  additionalProperties: false
                }
              }
            }
          ]
        }
      });

      expect(response.statusCode).toBe(502);
      expect(response.json().error).toMatchObject({
        code: "tool_call_validation_failed",
        message: "Expected valid JSON object output."
      });
      expect(provider.messages).toHaveLength(2);

      await app.close();
    }
  });

  it("honors tool_choice none by avoiding strict mode and suppressing tool calls", async () => {
    const provider = new FakeProvider([
      {
        type: "tool_call",
        callId: "call_ignored",
        name: "shell",
        arguments: { command: "pwd" }
      },
      { type: "message_delta", text: "answered without tools" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Answer directly." }],
        tool_choice: "none",
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: "answered without tools"
      },
      finish_reason: "stop"
    });
    expect(response.json().choices[0].message.tool_calls).toBeUndefined();
    expect(provider.messages[0].message).toContain("tool_choice=none");
    expect(provider.messages[0].message).not.toContain("strict client-defined tools mode");

    await app.close();
  });

  it("requires a strict tool call when tool_choice is required", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "message",
          content: "I can answer directly."
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use the evidence tool." }],
        tool_choice: "required",
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({
      code: "tool_call_validation_failed",
      type: "server_error"
    });
    expect(response.json().error.message).toContain("tool_choice=required");
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[0].message).toContain("tool_choice=required");

    await app.close();
  });

  it("honors a named function tool_choice", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "search",
              arguments: {
                query: "aspirin myocardial infarction"
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Search the literature." }],
        tool_choice: {
          type: "function",
          function: { name: "search" }
        },
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          },
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.tool_calls[0].function).toMatchObject({
      name: "search",
      arguments: '{"query":"aspirin myocardial infarction"}'
    });
    expect(provider.messages[0].message).toContain("function.name=search");

    await app.close();
  });

  it("rejects a named tool_choice that is not declared in tools", async () => {
    const provider = new FakeProvider();
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Search the literature." }],
        tool_choice: {
          type: "function",
          function: { name: "search" }
        },
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "invalid_request",
      type: "invalid_request_error"
    });
    expect(response.json().error.message).toContain("was not declared");
    expect(provider.messages).toHaveLength(0);

    await app.close();
  });

  it("validates complex strict tool schemas", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              id: "call_search_1",
              name: "search",
              arguments: {
                query: "statins primary prevention",
                filters: {
                  kind: "guideline",
                  years: [2021, 2024]
                },
                tags: ["cardiology", "prevention"]
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Find a guideline." }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  filters: {
                    type: "object",
                    properties: {
                      kind: { type: "string", enum: ["trial", "guideline"] },
                      years: {
                        type: "array",
                        items: { type: "integer" },
                        minItems: 1
                      }
                    },
                    required: ["kind"],
                    additionalProperties: false
                  },
                  tags: {
                    type: "array",
                    items: { type: "string" }
                  }
                },
                required: ["query", "filters"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const call = response.json().choices[0].message.tool_calls[0];
    expect(call).toMatchObject({
      id: "call_search_1",
      type: "function",
      function: { name: "search" }
    });
    expect(JSON.parse(call.function.arguments)).toEqual({
      query: "statins primary prevention",
      filters: {
        kind: "guideline",
        years: [2021, 2024]
      },
      tags: ["cardiology", "prevention"]
    });

    await app.close();
  });

  it("rejects additional properties in strict tool schemas", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "search",
              arguments: {
                query: "statins",
                filters: {
                  kind: "guideline",
                  unexpected: true
                }
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Find a guideline." }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  filters: {
                    type: "object",
                    properties: {
                      kind: { type: "string", enum: ["trial", "guideline"] }
                    },
                    required: ["kind"],
                    additionalProperties: false
                  }
                },
                required: ["query", "filters"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("tool_call_validation_failed");
    expect(response.json().error.message).toContain("additional properties");

    await app.close();
  });

  it("streams OpenAI tool call chunks with tool_calls finish reason", async () => {
    const provider = new FakeProvider([
      {
        type: "tool_call",
        callId: "call_1",
        name: "bash",
        arguments: { command: "ls" }
      },
      { type: "message_delta", text: "server sandbox failed" },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 5,
          completionTokens: 1,
          totalTokens: 6
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "List files." }]
      }
    });

    expect(response.statusCode).toBe(200);
    const frames = parseOpenAISseData(response.payload);
    expect(frames[0]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" }, finish_reason: null }]
    });
    expect(frames[1]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"command":"ls"}'
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    });
    expect(frames[2]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6
      }
    });
    expect(response.payload).not.toContain("server sandbox failed");
    expect(response.payload).toContain("data: [DONE]");

    await app.close();
  });

  it("streams strict client-defined tool calls", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              id: "call_medevidence_1",
              name: "medevidence",
              arguments: {
                question: "What is the evidence?"
              }
            }
          ]
        })
      },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 7,
          completionTokens: 2,
          totalTokens: 9
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "Use the evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const frames = parseOpenAISseData(response.payload);
    expect(frames[1]).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_medevidence_1",
                type: "function",
                function: {
                  name: "medevidence",
                  arguments: '{"question":"What is the evidence?"}'
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    });
    expect(frames[2]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9
      }
    });

    await app.close();
  });

  it("accepts OpenAI tool result messages as chat history context", async () => {
    const provider = new FakeProvider([
      { type: "message_delta", text: "The directory contains file1.txt." },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [
          { role: "user", content: "List files." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"command":"ls"}'
                }
              }
            ]
          },
          { role: "tool", tool_call_id: "call_1", content: "file1.txt" },
          { role: "user", content: "Summarize the result." }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(provider.messages[0].message).toContain("[assistant tool_calls]");
    expect(provider.messages[0].message).toContain('"id":"call_1"');
    expect(provider.messages[0].message).toContain("[tool tool_call_id=call_1]");
    expect(provider.messages[0].message).toContain("file1.txt");

    await app.close();
  });

  it("uses OpenAI-style error envelopes for /v1 requests", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: { model: "medcode", messages: [] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "messages must be a non-empty array.",
        type: "invalid_request_error",
        code: "invalid_request",
        param: null
      }
    });

    await app.close();
  });

  it("creates a session, streams a message, and stores provider session ref", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.id as string;

    const streamed = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "hello" }
    });

    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    expect(streamed.payload).toContain("event: message_delta");
    expect(streamed.payload).toContain('data: {"type":"message_delta","text":"echo:hello"}');
    expect(streamed.payload).toContain("event: completed");

    const listed = await app.inject({
      method: "GET",
      url: "/sessions",
      headers
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions[0].provider_session_ref).toBe("provider_thread_1");

    await app.close();
  });

  it("sticks existing sessions to their selected upstream account", async () => {
    const firstProvider = new FakeProvider();
    const secondProvider = new FakeProvider();
    const app = buildGateway({
      accessToken: "secret",
      upstreamAccounts: [
        {
          upstreamAccount: testUpstreamAccount("codex-pro-1"),
          provider: firstProvider,
          maxConcurrent: 1
        },
        {
          upstreamAccount: testUpstreamAccount("codex-pro-2"),
          provider: secondProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    const sessionId = created.json().session.id as string;

    const first = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "first" }
    });
    const second = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "second" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const messages = [...firstProvider.messages, ...secondProvider.messages];
    expect(messages).toHaveLength(2);
    expect(messages[0].upstreamAccount.id).toBe(messages[1].upstreamAccount.id);
    expect(
      [firstProvider.messages.length, secondProvider.messages.length].sort((a, b) => a - b)
    ).toEqual([0, 2]);

    await app.close();
  });

  it("does not fail over an existing session when its sticky upstream account is unavailable", async () => {
    const firstProvider = new FakeProvider();
    const secondProvider = new FakeProvider();
    const firstAccount = testUpstreamAccount("codex-pro-1");
    const secondAccount = testUpstreamAccount("codex-pro-2");
    const app = buildGateway({
      accessToken: "secret",
      upstreamAccounts: [
        {
          upstreamAccount: firstAccount,
          provider: firstProvider,
          maxConcurrent: 1
        },
        {
          upstreamAccount: secondAccount,
          provider: secondProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    const sessionId = created.json().session.id as string;
    const first = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "first" }
    });
    const selectedAccountId =
      firstProvider.messages[0]?.upstreamAccount.id ??
      secondProvider.messages[0]?.upstreamAccount.id;
    const selectedAccount = [firstAccount, secondAccount].find(
      (account) => account.id === selectedAccountId
    );
    if (!selectedAccount) {
      throw new Error("expected first request to select an upstream account");
    }
    selectedAccount.state = "disabled";

    const second = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "second" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(503);
    expect(second.json().error.code).toBe("subscription_unavailable");
    expect(firstProvider.messages.length + secondProvider.messages.length).toBe(1);

    await app.close();
  });

  it("uses HRW soft affinity to route stateless chat for different credentials", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    const accountIds = ["codex-pro-1", "codex-pro-2"];
    const issuedByAccount = new Map<string, ReturnType<typeof issueAccessCredential>>();
    for (let i = 0; i < 200 && issuedByAccount.size < 2; i += 1) {
      const issued = issueAccessCredential({
        subjectId: "subj_dev",
        label: `Affinity credential ${i}`,
        scope: "code",
        expiresAt: new Date("2030-02-01T00:00:00Z"),
        now: new Date("2026-01-01T00:00:00Z")
      });
      store.insertAccessCredential(issued.record);
      const selectedAccountId = hrwAccountForKey(issued.record.id, accountIds);
      issuedByAccount.set(selectedAccountId, issued);
    }
    expect(issuedByAccount.size).toBe(2);

    const firstProvider = new FakeProvider();
    const secondProvider = new FakeProvider();
    const app = buildGateway({
      authMode: "credential",
      sessionStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: testUpstreamAccount("codex-pro-1"),
          provider: firstProvider,
          maxConcurrent: 10
        },
        {
          upstreamAccount: testUpstreamAccount("codex-pro-2"),
          provider: secondProvider,
          maxConcurrent: 10
        }
      ],
      logger: false
    });

    for (const issued of issuedByAccount.values()) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${issued.token}` },
        payload: {
          model: "medcode",
          messages: [{ role: "user", content: "Say ok." }]
        }
      });
      expect(response.statusCode).toBe(200);
    }

    expect(firstProvider.messages).toHaveLength(1);
    expect(secondProvider.messages).toHaveLength(1);

    await app.close();
  });

  it("honors configured softAffinity=none when creating new sessions", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-upstream-affinity-"));
    const configPath = path.join(dir, "upstream-accounts.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        accounts: [
          {
            id: "codex-pro-1",
            label: "Codex Pro 1",
            provider: "openai-codex",
            codexHome: path.join(dir, "codex-home-pro-1"),
            enabled: true,
            initialState: "active",
            weight: 1,
            maxConcurrent: 1
          },
          {
            id: "codex-pro-2",
            label: "Codex Pro 2",
            provider: "openai-codex",
            codexHome: path.join(dir, "codex-home-pro-2"),
            enabled: true,
            initialState: "active",
            weight: 1,
            maxConcurrent: 1
          }
        ],
        selection: {
          strategy: "least_inflight",
          softAffinity: "none"
        }
      })
    );
    const accountIds = ["codex-pro-1", "codex-pro-2"];
    const store = createSqliteStore({ path: ":memory:" });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    const issued = issueCredentialForHrwAccount("codex-pro-2", accountIds);
    store.insertAccessCredential(issued.record);
    const previousPool = process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON;
    process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON = configPath;
    const app = buildGateway({
      authMode: "credential",
      sessionStore: store,
      logger: false
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${issued.token}` }
      });

      expect(created.statusCode).toBe(201);
      expect(store.list("subj_dev")[0].upstreamAccountId).toBe("codex-pro-1");
    } finally {
      await app.close();
      if (previousPool === undefined) {
        delete process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON;
      } else {
        process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON = previousPool;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the single-account fallback when no upstream pool config is set", async () => {
    const previousPool = process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON;
    delete process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON;
    const provider = new FakeProvider();
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer secret" },
        payload: {
          model: "medcode",
          messages: [{ role: "user", content: "Say ok." }]
        }
      });

      expect(response.statusCode).toBe(200);
      expect(provider.messages).toHaveLength(1);
      expect(provider.messages[0].upstreamAccount.id).toBe("sub_openai_codex_dev");
    } finally {
      if (previousPool === undefined) {
        delete process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON;
      } else {
        process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON = previousPool;
      }
      await app.close();
    }
  });

  it("records null upstream account for auth failures before selection", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      observationStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("missing_credential");
    expect(store.listRequestEvents({ limit: 5 })).toEqual([
      expect.objectContaining({
        credentialId: null,
        subjectId: null,
        upstreamAccountId: null,
        status: "error",
        errorCode: "missing_credential"
      })
    ]);

    await app.close();
  });

  it("retries stateless non-streaming chat before first byte and records cooldown", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const firstAccount = testUpstreamAccount("codex-pro-1");
    const secondAccount = testUpstreamAccount("codex-pro-2");
    const firstProvider = new FakeProvider([
      { type: "error", code: "service_unavailable", message: "temporary upstream failure" }
    ]);
    const secondProvider = new FakeProvider([
      { type: "message_delta", text: "retry-ok" },
      { type: "completed", providerSessionRef: "provider_thread_2" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      authMode: "dev",
      sessionStore: store,
      observationStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: firstAccount,
          provider: firstProvider,
          maxConcurrent: 1
        },
        {
          upstreamAccount: secondAccount,
          provider: secondProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("retry-ok");
    expect(firstProvider.messages).toHaveLength(1);
    expect(secondProvider.messages).toHaveLength(1);
    expect(firstAccount.cooldownUntil).toBeInstanceOf(Date);
    expect(store.getUpstreamAccount("codex-pro-1")).toMatchObject({
      state: "active",
      cooldownUntil: firstAccount.cooldownUntil
    });
    expect(store.listRequestEvents({ limit: 5 })).toEqual([
      expect.objectContaining({
        upstreamAccountId: "codex-pro-2",
        status: "ok",
        errorCode: null
      })
    ]);

    await app.close();
  });

  it("persists reauth_required outcome for a stateless provider failure", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const account = testUpstreamAccount("codex-pro-1");
    const provider = new FakeProvider([
      {
        type: "error",
        code: "provider_reauth_required",
        message: "reauthorization required"
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      authMode: "dev",
      sessionStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: account,
          provider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("provider_reauth_required");
    expect(account.state).toBe("reauth_required");
    expect(account.cooldownUntil).toBeInstanceOf(Date);
    expect(store.getUpstreamAccount("codex-pro-1")).toMatchObject({
      state: "reauth_required",
      cooldownUntil: account.cooldownUntil
    });

    await app.close();
  });

  it("honors the stateless retry cap when attempted accounts keep failing", async () => {
    const accounts = [
      testUpstreamAccount("codex-pro-1"),
      testUpstreamAccount("codex-pro-2"),
      testUpstreamAccount("codex-pro-3")
    ];
    const providers = accounts.map(
      () =>
        new FakeProvider([
          {
            type: "error",
            code: "service_unavailable",
            message: "temporary upstream failure"
          }
        ])
    );
    const app = buildGateway({
      accessToken: "secret",
      upstreamAccounts: accounts.map((account, index) => ({
        upstreamAccount: account,
        provider: providers[index],
        maxConcurrent: 1
      })),
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("service_unavailable");
    expect(providers.map((provider) => provider.messages.length)).toEqual([1, 1, 0]);
    expect(accounts[0].cooldownUntil).toBeInstanceOf(Date);
    expect(accounts[1].cooldownUntil).toBeInstanceOf(Date);
    expect(accounts[2].cooldownUntil).toBeNull();

    await app.close();
  });

  it("retries stateless streaming chat before the first business chunk", async () => {
    const firstAccount = testUpstreamAccount("codex-pro-1");
    const secondAccount = testUpstreamAccount("codex-pro-2");
    const firstProvider = new FakeProvider([
      { type: "error", code: "rate_limited", message: "rate limited" }
    ]);
    const secondProvider = new FakeProvider([
      { type: "message_delta", text: "stream-retry-ok" },
      { type: "completed", providerSessionRef: "provider_thread_2" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      upstreamAccounts: [
        {
          upstreamAccount: firstAccount,
          provider: firstProvider,
          maxConcurrent: 1
        },
        {
          upstreamAccount: secondAccount,
          provider: secondProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain("stream-retry-ok");
    expect(response.payload).not.toContain("rate limited");
    expect(firstProvider.messages).toHaveLength(1);
    expect(secondProvider.messages).toHaveLength(1);
    expect(firstAccount.cooldownUntil).toBeInstanceOf(Date);

    await app.close();
  });

  it("honors the stateless streaming retry cap before the first business chunk", async () => {
    const accounts = [
      testUpstreamAccount("codex-pro-1"),
      testUpstreamAccount("codex-pro-2"),
      testUpstreamAccount("codex-pro-3")
    ];
    const providers = accounts.map(
      () =>
        new FakeProvider([
          {
            type: "error",
            code: "service_unavailable",
            message: "temporary upstream failure"
          }
        ])
    );
    const app = buildGateway({
      accessToken: "secret",
      upstreamAccounts: accounts.map((account, index) => ({
        upstreamAccount: account,
        provider: providers[index],
        maxConcurrent: 1
      })),
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain("service_unavailable");
    expect(providers.map((provider) => provider.messages.length)).toEqual([1, 1, 0]);
    expect(accounts[0].cooldownUntil).toBeInstanceOf(Date);
    expect(accounts[1].cooldownUntil).toBeInstanceOf(Date);
    expect(accounts[2].cooldownUntil).toBeNull();

    await app.close();
  });

  it("does not retry stateless streaming chat after a business chunk is visible", async () => {
    const firstAccount = testUpstreamAccount("codex-pro-1");
    const secondAccount = testUpstreamAccount("codex-pro-2");
    const firstProvider = new FakeProvider([
      { type: "message_delta", text: "partial" },
      { type: "error", code: "service_unavailable", message: "temporary upstream failure" }
    ]);
    const secondProvider = new FakeProvider([
      { type: "message_delta", text: "should-not-run" },
      { type: "completed", providerSessionRef: "provider_thread_2" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      upstreamAccounts: [
        {
          upstreamAccount: firstAccount,
          provider: firstProvider,
          maxConcurrent: 1
        },
        {
          upstreamAccount: secondAccount,
          provider: secondProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain("partial");
    expect(response.payload).toContain("service_unavailable");
    expect(firstProvider.messages).toHaveLength(1);
    expect(secondProvider.messages).toHaveLength(0);
    expect(firstAccount.cooldownUntil).toBeInstanceOf(Date);

    await app.close();
  });

  it("records cooldown for existing-session provider errors without failover", async () => {
    const firstAccount = testUpstreamAccount("codex-pro-1");
    const secondAccount = testUpstreamAccount("codex-pro-2");
    const firstProvider = new FakeProvider([
      { type: "error", code: "rate_limited", message: "sticky account limited" }
    ]);
    const secondProvider = new FakeProvider([
      { type: "message_delta", text: "should-not-run" },
      { type: "completed", providerSessionRef: "provider_thread_2" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      upstreamAccounts: [
        {
          upstreamAccount: firstAccount,
          provider: firstProvider,
          maxConcurrent: 1
        },
        {
          upstreamAccount: secondAccount,
          provider: secondProvider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    const sessionId = created.json().session.id as string;
    const streamed = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "first" }
    });

    expect(streamed.statusCode).toBe(200);
    expect(streamed.payload).toContain("sticky account limited");
    expect(firstProvider.messages).toHaveLength(1);
    expect(secondProvider.messages).toHaveLength(0);
    expect(firstAccount.cooldownUntil).toBeInstanceOf(Date);

    await app.close();
  });

  it("records the selected upstream account in request events", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      authMode: "dev",
      sessionStore: store,
      observationStore: store,
      upstreamAccounts: [
        {
          upstreamAccount: testUpstreamAccount("codex-pro-1"),
          provider,
          maxConcurrent: 1
        }
      ],
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(provider.messages).toHaveLength(1);
    const events = store.listRequestEvents({ limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0].upstreamAccountId).toBe(provider.messages[0].upstreamAccount.id);

    await app.close();
  });

  it("uses stored upstream account state instead of config initialState", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-upstream-pool-"));
    const configPath = path.join(dir, "upstream-accounts.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        accounts: [
          {
            id: "codex-pro-1",
            label: "Codex Pro 1",
            provider: "openai-codex",
            codexHome: path.join(dir, "codex-home-pro-1"),
            enabled: true,
            initialState: "active",
            weight: 1,
            maxConcurrent: 1
          }
        ]
      })
    );
    const store = createSqliteStore({ path: ":memory:" });
    store.upsertUpstreamAccount(testUpstreamAccount("codex-pro-1", { state: "disabled" }));

    const previousPool = process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON;
    process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON = configPath;
    const app = buildGateway({
      accessToken: "secret",
      authMode: "dev",
      sessionStore: store,
      logger: false
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer secret" }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("subscription_unavailable");
    } finally {
      await app.close();
      if (previousPool === undefined) {
        delete process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON;
      } else {
        process.env.GATEWAY_UPSTREAM_ACCOUNTS_JSON = previousPool;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns invalid_request for an empty message", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    const sessionId = created.json().session.id as string;

    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");

    await app.close();
  });

  it("hides sessions that belong to a different subject", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-subject-"));
    const dbPath = path.join(dir, "gateway.db");
    const headers = { authorization: "Bearer secret" };

    try {
      const first = buildGateway({
        authMode: "dev",
        accessToken: "secret",
        provider: new FakeProvider(),
        sessionStore: createSqliteStore({ path: dbPath }),
        logger: false
      });

      const created = await first.inject({
        method: "POST",
        url: "/sessions",
        headers
      });
      const sessionId = created.json().session.id as string;
      await first.close();

      const second = buildGateway({
        authMode: "dev",
        accessToken: "secret",
        provider: new FakeProvider(),
        sessionStore: createSqliteStore({ path: dbPath }),
        subject: {
          id: "subj_other",
          label: "Other",
          state: "active",
          createdAt: new Date("2026-01-01T00:00:00Z")
        },
        logger: false
      });

      const hidden = await second.inject({
        method: "POST",
        url: `/sessions/${sessionId}/messages`,
        headers,
        payload: { message: "hello" }
      });

      expect(hidden.statusCode).toBe(404);
      expect(hidden.json().error.code).toBe("session_not_found");

      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authenticates requests with sqlite-backed access credentials", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Integration token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const rejected = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: "Bearer wrong" }
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe("invalid_credential");

    const accepted = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: `Bearer ${issued.token}` }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      credential: {
        prefix: issued.record.prefix,
        scope: "code",
        expires_at: "2030-02-01T00:00:00.000Z"
      },
      subject: {
        id: "subj_dev"
      }
    });

    await app.close();
  });

  it("rejects revoked sqlite-backed access credentials", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Revoked token",
      scope: "code",
      expiresAt: new Date("2026-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.revokeAccessCredentialByPrefix(issued.record.prefix, new Date("2026-01-02T00:00:00Z"));
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: `Bearer ${issued.token}` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("revoked_credential");

    await app.close();
  });

  it("rejects API keys that belong to a disabled user", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "alice",
      label: "Alice token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "alice",
      label: "Alice",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.setSubjectState("alice", "disabled");
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: `Bearer ${issued.token}` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credential");

    await app.close();
  });

  it("rate-limits sqlite-backed access credentials", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Rate limited token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: 1
      }
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const first = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatchObject({
      code: "rate_limited",
      retry_after_seconds: expect.any(Number)
    });

    await app.close();
  });

  it("records request events for credential traffic and rate limits", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Observed token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: 1
      }
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const first = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    const firstRequestId = expectRequestIdHeader(first);
    await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });

    const events = store.listRequestEvents({ credentialId: issued.record.id });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.requestId)).toContain(firstRequestId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          credentialId: issued.record.id,
          subjectId: "subj_dev",
          scope: "code",
          status: "ok",
          errorCode: null,
          rateLimited: false
        }),
        expect.objectContaining({
          credentialId: issued.record.id,
          subjectId: "subj_dev",
          scope: "code",
          status: "error",
          errorCode: "rate_limited",
          rateLimited: true
        })
      ])
    );
    expect(events.every((event) => event.durationMs !== null)).toBe(true);
    expect(events.every((event) => event.firstByteMs !== null)).toBe(true);

    await app.close();
  });

  it("records provider token usage in request observations", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Observed usage token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          cachedPromptTokens: 4
        }
      }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });
    const requestId = expectRequestIdHeader(response);

    expect(response.statusCode).toBe(200);
    expect(store.listRequestEvents({ credentialId: issued.record.id })).toEqual([
      expect.objectContaining({
        requestId,
        credentialId: issued.record.id,
        publicModelId: "medcode",
        upstreamRuntime: "codex",
        upstreamModel: "gpt-5.5",
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        cachedPromptTokens: 4,
        estimatedTokens: null,
        usageSource: "provider"
      })
    ]);

    await app.close();
  });

  it("keeps legacy medcode streaming and strict tools on Codex runtime with observations", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Legacy medcode compatibility token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "medevidence",
              arguments: { question: "What evidence supports aspirin after MI?" }
            }
          ]
        })
      },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 20,
          completionTokens: 3,
          totalTokens: 23
        }
      }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      observationStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const streamed = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "Say ok." }]
      }
    });
    const strict = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Answer with evidence." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: "required"
      }
    });

    expect(streamed.statusCode).toBe(200);
    expect(streamed.payload).toContain("data: [DONE]");
    expect(strict.statusCode).toBe(200);
    expect(strict.json().choices[0].finish_reason).toBe("tool_calls");
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages.every((message) => message.upstreamAccount.provider === "openai-codex")).toBe(true);
    expect(store.listRequestEvents({ credentialId: issued.record.id })).toEqual([
      expect.objectContaining({
        publicModelId: "medcode",
        upstreamRuntime: "codex",
        upstreamModel: "gpt-5.5",
        provider: "openai-codex",
        status: "ok",
        totalTokens: 23,
        usageSource: "provider"
      }),
      expect.objectContaining({
        publicModelId: "medcode",
        upstreamRuntime: "codex",
        upstreamModel: "gpt-5.5",
        provider: "openai-codex",
        status: "ok",
        totalTokens: 23,
        usageSource: "provider"
      })
    ]);

    await app.close();
  });

  it("keeps credentials without token policy usable and records soft-write usage", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Legacy usage token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12
        }
      }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const current = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).not.toHaveProperty("token_usage");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(provider.messages).toHaveLength(1);
    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const reservations = limiter.listReservations({
      subjectId: "subj_dev",
      includeFinalized: true
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      kind: "soft_write",
      reservedTokens: 0,
      finalTotalTokens: 12,
      finalUsageSource: "soft_write"
    });
    expect(store.listRequestEvents({ credentialId: issued.record.id })[0]).toMatchObject({
      reservationId: reservations[0].id,
      totalTokens: 12,
      usageSource: "provider"
    });

    await app.close();
  });

  it("uses active plan entitlements for token budgets without exposing internal charge fields", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Entitled credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.createPlan({
      id: "plan_pro_v1",
      displayName: "Pro",
      scopeAllowlist: ["code"],
      policy: {
        tokensPerMinute: 1_000,
        tokensPerDay: 10_000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: 500,
        maxTotalTokensPerRequest: 1_000,
        reserveTokensPerRequest: 100,
        missingUsageCharge: "reserve"
      },
      now: new Date("2026-01-01T00:00:00Z")
    });
    const entitlement = store.grantEntitlement({
      subjectId: "subj_dev",
      planId: "plan_pro_v1",
      periodKind: "unlimited",
      now: new Date("2026-01-01T00:00:00Z")
    });
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12
        }
      }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const current = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      plan: {
        display_name: "Pro",
        scope_allowlist: ["code"]
      },
      entitlement: {
        period_kind: "unlimited",
        period_end: null,
        state: "active"
      },
      credential: {
        token: {
          tokensPerMinute: 1_000,
          tokensPerDay: 10_000,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: 500,
          maxTotalTokensPerRequest: 1_000
        }
      },
      token_usage: {
        source: "entitlement",
        day: {
          limit: 10_000,
          used: 0,
          reserved: 0,
          remaining: 10_000
        }
      }
    });
    expect(JSON.stringify(current.json())).not.toContain("reserveTokensPerRequest");
    expect(JSON.stringify(current.json())).not.toContain("missingUsageCharge");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const reservations = limiter.listReservations({
      subjectId: "subj_dev",
      includeFinalized: true
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      kind: "reservation",
      entitlementId: entitlement.id,
      finalTotalTokens: 12,
      finalUsageSource: "provider"
    });

    await app.close();
  });

  it("shows inactive entitlement state on current credential validation without token fallback", async () => {
    const cases = [
      { state: "expired", reason: undefined },
      { state: "paused", reason: "paused" },
      { state: "cancelled", reason: "cancelled" }
    ] as const;

    for (const item of cases) {
      const store = createSqliteStore({ path: ":memory:" });
      const issued = issueAccessCredential({
        subjectId: "subj_dev",
        label: `${item.state} entitlement credential`,
        scope: "code",
        expiresAt: new Date("2030-02-01T00:00:00Z"),
        now: new Date("2026-01-01T00:00:00Z"),
        rate: {
          requestsPerMinute: 30,
          requestsPerDay: null,
          concurrentRequests: 1,
          token: {
            tokensPerMinute: 1,
            tokensPerDay: 1,
            tokensPerMonth: null,
            maxPromptTokensPerRequest: null,
            maxTotalTokensPerRequest: null,
            reserveTokensPerRequest: 10,
            missingUsageCharge: "reserve"
          }
        }
      });
      store.upsertSubject({
        id: "subj_dev",
        label: "Credential Subject",
        state: "active",
        createdAt: new Date("2026-01-01T00:00:00Z")
      });
      store.insertAccessCredential(issued.record);
      store.createPlan({
        id: `plan_${item.state}_v1`,
        displayName: "Trial",
        scopeAllowlist: ["code"],
        policy: {
          tokensPerMinute: null,
          tokensPerDay: 10_000,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: null,
          maxTotalTokensPerRequest: null,
          reserveTokensPerRequest: 0,
          missingUsageCharge: "none"
        },
        now: new Date("2026-01-01T00:00:00Z")
      });
      const entitlement = store.grantEntitlement({
        subjectId: "subj_dev",
        planId: `plan_${item.state}_v1`,
        periodKind: item.state === "expired" ? "one_off" : "unlimited",
        periodStart:
          item.state === "expired" ? new Date("2000-01-01T00:00:00Z") : undefined,
        periodEnd:
          item.state === "expired" ? new Date("2000-01-02T00:00:00Z") : undefined,
        now: new Date("2026-01-01T00:00:00Z")
      });
      if (item.state === "paused") {
        store.pauseEntitlement({ id: entitlement.id });
      }
      if (item.state === "cancelled") {
        store.cancelEntitlement({ id: entitlement.id, reason: "test" });
      }

      const app = buildGateway({
        authMode: "credential",
        provider: new FakeProvider(),
        sessionStore: store,
        logger: false
      });
      const current = await app.inject({
        method: "GET",
        url: "/gateway/credentials/current",
        headers: { authorization: `Bearer ${issued.token}` }
      });
      const body = current.json();

      expect(current.statusCode).toBe(200);
      expect(body).toMatchObject({
        plan: {
          display_name: "Trial",
          scope_allowlist: ["code"]
        },
        entitlement: {
          period_kind: item.state === "expired" ? "one_off" : "unlimited",
          state: item.state,
          ...(item.reason ? { reason: item.reason } : {})
        }
      });
      expect(body.credential).not.toHaveProperty("token");
      expect(body).not.toHaveProperty("token_usage");
      expect(JSON.stringify(body)).not.toContain("reserveTokensPerRequest");
      expect(JSON.stringify(body)).not.toContain("missingUsageCharge");

      await app.close();
    }
  });

  it("rejects legacy users only when entitlement enforcement is enabled", async () => {
    const previousRequireEntitlement = process.env.GATEWAY_REQUIRE_ENTITLEMENT;
    process.env.GATEWAY_REQUIRE_ENTITLEMENT = "1";
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Legacy strict credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider();
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${issued.token}` },
        payload: {
          model: "medcode",
          messages: [{ role: "user", content: "Say ok." }]
        }
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().error.code).toBe("plan_inactive");
      expect(provider.messages).toHaveLength(0);
    } finally {
      if (previousRequireEntitlement === undefined) {
        delete process.env.GATEWAY_REQUIRE_ENTITLEMENT;
      } else {
        process.env.GATEWAY_REQUIRE_ENTITLEMENT = previousRequireEntitlement;
      }
      await app.close();
    }
  });

  it("does not fall back to legacy token handling after an entitlement expires", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Expired entitlement credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.createPlan({
      id: "plan_trial_v1",
      displayName: "Trial",
      scopeAllowlist: ["code"],
      policy: {
        tokensPerMinute: null,
        tokensPerDay: 10_000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        reserveTokensPerRequest: 0,
        missingUsageCharge: "none"
      },
      now: new Date("2026-01-01T00:00:00Z")
    });
    const entitlement = store.grantEntitlement({
      subjectId: "subj_dev",
      planId: "plan_trial_v1",
      periodKind: "one_off",
      periodStart: new Date("2000-01-01T00:00:00Z"),
      periodEnd: new Date("2000-01-02T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    const provider = new FakeProvider();
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("plan_expired");
    expect(provider.messages).toHaveLength(0);
    expect(store.getEntitlement(entitlement.id)?.state).toBe("expired");

    await app.close();
  });

  it("blocks only credentials with token policy when token budget is exceeded", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Token limited credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 30,
        requestsPerDay: null,
        concurrentRequests: 1,
        token: {
          tokensPerMinute: null,
          tokensPerDay: null,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: null,
          maxTotalTokensPerRequest: 10,
          reserveTokensPerRequest: 100,
          missingUsageCharge: "reserve"
        }
      }
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider();
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("rate_limited");
    expect(provider.messages).toHaveLength(0);
    expect(store.listRequestEvents({ credentialId: issued.record.id })).toEqual([
      expect.objectContaining({
        status: "error",
        errorCode: "rate_limited",
        rateLimited: true,
        limitKind: "token_request_total",
        reservationId: null
      })
    ]);

    await app.close();
  });

  it("records reserve token finalize source when provider usage is missing", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Reserve usage token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 30,
        requestsPerDay: null,
        concurrentRequests: 1,
        token: {
          tokensPerMinute: null,
          tokensPerDay: null,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: null,
          maxTotalTokensPerRequest: null,
          reserveTokensPerRequest: 100,
          missingUsageCharge: "reserve"
        }
      }
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    const events = store.listRequestEvents({ credentialId: issued.record.id });
    expect(events).toEqual([
      expect.objectContaining({
        usageSource: "reserve",
        promptTokens: null,
        totalTokens: null
      })
    ]);
    expect(events[0].estimatedTokens).toBeGreaterThanOrEqual(100);

    await app.close();
  });

  it("records strict tool validation failures in request observations", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Strict validation observed token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "shell",
              arguments: { command: "ls" }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use a medical evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });
    const requestId = expectRequestIdHeader(response);

    expect(response.statusCode).toBe(502);
    const events = store.listRequestEvents({ credentialId: issued.record.id });
    expect(events).toEqual([
      expect.objectContaining({
        requestId,
        credentialId: issued.record.id,
        subjectId: "subj_dev",
        scope: "code",
        status: "error",
        errorCode: "tool_call_validation_failed",
        rateLimited: false
      })
    ]);

    await app.close();
  });

  it("can persist sessions through the sqlite store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-app-"));
    const dbPath = path.join(dir, "gateway.db");
    const headers = { authorization: "Bearer secret" };

    try {
      const first = buildGateway({
        authMode: "dev",
        accessToken: "secret",
        provider: new FakeProvider(),
        sessionStore: createSqliteStore({ path: dbPath }),
        logger: false
      });

      const created = await first.inject({
        method: "POST",
        url: "/sessions",
        headers
      });
      const sessionId = created.json().session.id as string;

      await first.inject({
        method: "POST",
        url: `/sessions/${sessionId}/messages`,
        headers,
        payload: { message: "persist" }
      });
      await first.close();

      const second = buildGateway({
        authMode: "dev",
        accessToken: "secret",
        provider: new FakeProvider(),
        sessionStore: createSqliteStore({ path: dbPath }),
        logger: false
      });

      const listed = await second.inject({
        method: "GET",
        url: "/sessions",
        headers
      });

      expect(listed.statusCode).toBe(200);
      expect(listed.json().sessions).toMatchObject([
        {
          id: sessionId,
          provider_session_ref: "provider_thread_1"
        }
      ]);

      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function parseOpenAISseData(payload: string): unknown[] {
  return payload
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as unknown);
}

function expectRequestIdHeader(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["x-request-id"];
  const requestId = Array.isArray(value) ? value[0] : value;
  expect(typeof requestId).toBe("string");
  expect(requestId).toMatch(/^req-/);
  return requestId as string;
}

function testUpstreamAccount(id: string, overrides: Partial<UpstreamAccount> = {}): UpstreamAccount {
  return {
    id,
    provider: "openai-codex",
    label: id,
    credentialRef: `CODEX_HOME:${id}`,
    imageApiKeyEnv: overrides.imageApiKeyEnv ?? null,
    state: overrides.state ?? "active",
    lastUsedAt: overrides.lastUsedAt ?? null,
    cooldownUntil: overrides.cooldownUntil ?? null
  };
}

function hrwAccountForKey(affinityKey: string, accountIds: string[]): string {
  return accountIds.reduce((best, accountId) =>
    hrwScore(affinityKey, accountId) > hrwScore(affinityKey, best) ? accountId : best
  );
}

function hrwScore(affinityKey: string, accountId: string): string {
  return createHash("sha256").update(affinityKey).update("\0").update(accountId).digest("hex");
}

function issueCredentialForHrwAccount(accountId: string, accountIds: string[]) {
  for (let i = 0; i < 200; i += 1) {
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: `Affinity credential ${i}`,
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    if (hrwAccountForKey(issued.record.id, accountIds) === accountId) {
      return issued;
    }
  }
  throw new Error(`Could not issue a test credential for ${accountId}.`);
}

function createCredentialBackedStore(rate?: RateLimitPolicy) {
  const store = createSqliteStore({ path: ":memory:" });
  const issued = issueAccessCredential({
    subjectId: "subj_dev",
    label: "Client event credential",
    scope: "code",
    expiresAt: new Date("2030-02-01T00:00:00Z"),
    now: new Date("2026-01-01T00:00:00Z"),
    rate
  });
  store.upsertSubject({
    id: "subj_dev",
    label: "Credential Subject",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  });
  store.insertAccessCredential(issued.record);

  return {
    store,
    issued,
    headers: { authorization: `Bearer ${issued.token}` }
  };
}

function createImageEntitledStore(issued = issueAccessCredential({
  subjectId: "subj_dev",
  label: "Image generation credential",
  scope: "code",
  expiresAt: new Date("2030-02-01T00:00:00Z"),
  now: new Date("2026-01-01T00:00:00Z")
})) {
  const store = createSqliteStore({ path: ":memory:" });
  store.upsertSubject({
    id: "subj_dev",
    label: "Credential Subject",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  });
  store.insertAccessCredential(issued.record);
  store.createPlan({
    id: "plan_image_v1",
    displayName: "Image Trial",
    scopeAllowlist: ["code"],
    policy: unrestrictedTokenPolicy(),
    featurePolicy: imageFeaturePolicy(),
    now: new Date("2026-01-01T00:00:00Z")
  });
  store.grantEntitlement({
    subjectId: "subj_dev",
    planId: "plan_image_v1",
    periodKind: "unlimited",
    now: new Date("2026-01-01T00:00:00Z")
  });

  return {
    store,
    issued,
    headers: { authorization: `Bearer ${issued.token}` }
  };
}

function unrestrictedTokenPolicy() {
  return {
    tokensPerMinute: null,
    tokensPerDay: null,
    tokensPerMonth: null,
    maxPromptTokensPerRequest: null,
    maxTotalTokensPerRequest: null,
    reserveTokensPerRequest: 0,
    missingUsageCharge: "none" as const
  };
}

function imageFeaturePolicy() {
  return validateFeaturePolicy({
    capabilities: ["chat", "tools", "image_generation"] as const,
    imageGeneration: defaultImageGenerationFeaturePolicy()
  });
}

function createModelEntitledStore(allowedModels: string[] | null) {
  const store = createSqliteStore({ path: ":memory:" });
  const issued = issueAccessCredential({
    subjectId: "subj_dev",
    label: "Model entitlement credential",
    scope: "code",
    expiresAt: new Date("2030-02-01T00:00:00Z"),
    now: new Date("2026-01-01T00:00:00Z")
  });
  store.upsertSubject({
    id: "subj_dev",
    label: "Credential Subject",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  });
  store.insertAccessCredential(issued.record);
  store.createPlan({
    id: `plan_models_${allowedModels?.join("_") || "legacy"}_v1`,
    displayName: "Model Trial",
    scopeAllowlist: ["code"],
    policy: unrestrictedTokenPolicy(),
    featurePolicy: validateFeaturePolicy({
      capabilities: ["chat", "tools"],
      ...(allowedModels
        ? {
            medcode_models: {
              allowed: allowedModels
            }
          }
        : {})
    }),
    now: new Date("2026-01-01T00:00:00Z")
  });
  store.grantEntitlement({
    subjectId: "subj_dev",
    planId: `plan_models_${allowedModels?.join("_") || "legacy"}_v1`,
    periodKind: "unlimited",
    now: new Date("2026-01-01T00:00:00Z")
  });

  return {
    store,
    issued,
    headers: { authorization: `Bearer ${issued.token}` }
  };
}

function publicModelRegistryFixture() {
  return {
    medcode: {
      displayName: "Max",
      runtime: "codex",
      upstreamModel: "gpt-5.5",
      contextWindow: 400000,
      upstreamContextWindow: 400000,
      maxOutputTokens: 128000,
      enabled: true
    },
    pro: {
      displayName: "Pro",
      runtime: "openrouter",
      upstreamModel: "z-ai/glm-5.2",
      contextWindow: 200000,
      upstreamContextWindow: 1048576,
      reasoning: { effort: "none" },
      enabled: true
    },
    standard: {
      displayName: "Standard",
      runtime: "openrouter",
      upstreamModel: "deepseek/deepseek-v4-pro",
      contextWindow: 200000,
      upstreamContextWindow: 1048576,
      reasoning: { effort: "none" },
      enabled: true
    }
  };
}

async function withTemporaryEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function startOpenAICompatibleSseServer(
  handler: (
    request: http.IncomingMessage,
    body: string,
    response: http.ServerResponse
  ) => Promise<void> | void
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      void handler(request, body, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (lastError) {
    throw lastError;
  }
}

function clientMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "client_message.v1",
    event_id: "evt_1",
    session_id: "ses_1",
    message_id: "msg_1",
    created_at: "2026-04-29T10:00:00.000Z",
    app: {
      name: "medevidence-desktop",
      version: "1.4.6"
    },
    agent: "research",
    provider_id: "medcode",
    model_id: "medcode",
    engine: "agent",
    text: "What is the latest evidence?",
    attachments: [],
    ...overrides
  };
}

function clientDiagnosticPayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "client_diagnostic.v1",
    event_id: "diag_1",
    session_id: "ses_1",
    message_id: "msg_1",
    created_at: "2026-04-29T10:00:00.000Z",
    app: {
      name: "medevidence-desktop",
      version: "1.4.6"
    },
    category: "http",
    action: "GET /session/:sessionID/message",
    status: "ok",
    method: "GET",
    path: "/session/ses_1/message",
    duration_ms: 120,
    http_status: 200,
    metadata: {},
    ...overrides
  };
}
