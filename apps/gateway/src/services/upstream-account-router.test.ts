import { describe, expect, it } from "vitest";
import type {
  MessageInput,
  ProviderAdapter,
  ProviderHealth,
  StreamEvent,
  UpstreamAccount
} from "@codex-gateway/core";
import {
  applyStartupAuthState,
  parseUpstreamAccountPoolConfig,
  UpstreamAccountRouter,
  type ImageProviderOutcome,
  type UpstreamAccountRuntimeInput
} from "./upstream-account-router.js";
import type { ImageGenerationProvider } from "../image-generation.js";

class FakeProvider implements ProviderAdapter {
  readonly kind = "fake";

  async health(_upstreamAccount: UpstreamAccount): Promise<ProviderHealth> {
    return {
      state: "healthy",
      checkedAt: new Date("2026-01-01T00:00:00Z")
    };
  }

  async *message(_input: MessageInput): AsyncIterable<StreamEvent> {
    yield { type: "completed" };
  }
}

class FakeImageGenerationProvider implements ImageGenerationProvider {
  async generate(): Promise<never> {
    throw new Error("not implemented");
  }
}

describe("UpstreamAccountRouter", () => {
  it("parses pool config and rejects duplicate account ids", () => {
    expect(() =>
      parseUpstreamAccountPoolConfig(
        JSON.stringify({
          accounts: [
            accountConfig("codex-pro-1", "/var/lib/codex-gateway/codex-home-pro-1"),
            accountConfig("codex-pro-1", "/var/lib/codex-gateway/codex-home-pro-2")
          ]
        }),
        { nodeEnv: "production" }
      )
    ).toThrow("Duplicate upstream account id 'codex-pro-1'");
  });

  it("requires absolute codexHome and explicit maxConcurrent in production config", () => {
    expect(() =>
      parseUpstreamAccountPoolConfig(
        JSON.stringify({
          accounts: [accountConfig("codex-pro-1", "relative/codex-home")]
        }),
        { nodeEnv: "production" }
      )
    ).toThrow("codexHome must be an absolute path");

    const missingMaxConcurrent = accountConfig(
      "codex-pro-1",
      "/var/lib/codex-gateway/codex-home-pro-1"
    ) as Record<string, unknown>;
    delete missingMaxConcurrent.maxConcurrent;
    expect(() =>
      parseUpstreamAccountPoolConfig(
        JSON.stringify({
          accounts: [missingMaxConcurrent]
        }),
        { nodeEnv: "production" }
      )
    ).toThrow("maxConcurrent must be a positive integer");
  });

  it("parses cooldown config and image binding fields", () => {
    const parsed = parseUpstreamAccountPoolConfig(
      JSON.stringify({
        accounts: [
          {
            ...accountConfig("codex-pro-1", "/var/lib/codex-gateway/codex-home-pro-1"),
            imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY",
            imageBaseUrlEnv: "MEDCODE_IMAGE_OPENAI_BASE_URL"
          }
        ],
        selection: {
          softAffinity: "subject"
        },
        cooldown: {
          rateLimitSeconds: 120,
          reauthSeconds: 900,
          serviceErrorSeconds: 30
        }
      }),
      {
        nodeEnv: "production"
      }
    );

    expect(parsed.accounts[0]).toMatchObject({
      imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY",
      imageBaseUrlEnv: "MEDCODE_IMAGE_OPENAI_BASE_URL"
    });
    expect(parsed.selection.softAffinity).toBe("subject");
    expect(parsed.cooldown).toEqual({
      rateLimitSeconds: 120,
      reauthSeconds: 900,
      serviceErrorSeconds: 30
    });
  });

  it("rejects imageApiKeyEnv values that look like secret key literals", () => {
    expect(() =>
      parseUpstreamAccountPoolConfig(
        JSON.stringify({
          accounts: [
            {
              ...accountConfig("codex-pro-1", "/var/lib/codex-gateway/codex-home-pro-1"),
              imageApiKeyEnv: "sk-test"
            }
          ]
        })
      )
    ).toThrow("imageApiKeyEnv must be an environment variable name");
  });

  it("does not select config-disabled accounts", () => {
    const router = new UpstreamAccountRouter([
      runtime("codex-pro-1", { enabled: false }),
      runtime("codex-pro-2")
    ]);

    const selection = router.selectForNewSession({ affinityKey: "credential-a" });

    expect(selection).not.toBeInstanceOf(Error);
    expect("upstreamAccount" in selection && selection.upstreamAccount.id).toBe("codex-pro-2");
  });

  it("applies soft affinity mode to HRW selection", () => {
    const runtimes = [
      runtime("codex-pro-1", { maxConcurrent: 10 }),
      runtime("codex-pro-2", { maxConcurrent: 10 })
    ];
    let keyForSecondAccount: string | null = null;
    for (let i = 0; i < 1000; i += 1) {
      const key = `credential-${i}`;
      const router = new UpstreamAccountRouter(runtimes, { softAffinity: "credential" });
      const selection = router.selectForNewSession({ affinityKey: key });
      if ("upstreamAccount" in selection && selection.upstreamAccount.id === "codex-pro-2") {
        keyForSecondAccount = key;
        break;
      }
    }

    expect(keyForSecondAccount).not.toBeNull();
    const affinityRouter = new UpstreamAccountRouter(runtimes, { softAffinity: "credential" });
    const noAffinityRouter = new UpstreamAccountRouter(runtimes, { softAffinity: "none" });
    const affinitySelection = affinityRouter.selectForNewSession({
      affinityKey: keyForSecondAccount
    });
    const noAffinitySelection = noAffinityRouter.selectForNewSession({
      affinityKey: keyForSecondAccount
    });

    expect("upstreamAccount" in affinitySelection && affinitySelection.upstreamAccount.id).toBe(
      "codex-pro-2"
    );
    expect("upstreamAccount" in noAffinitySelection && noAffinitySelection.upstreamAccount.id).toBe(
      "codex-pro-1"
    );
  });

  it("excludes every previously attempted account from retry selection", () => {
    const router = new UpstreamAccountRouter(
      [
        runtime("codex-pro-1", { maxConcurrent: 10 }),
        runtime("codex-pro-2", { maxConcurrent: 10 }),
        runtime("codex-pro-3", { maxConcurrent: 10 })
      ],
      { softAffinity: "none" }
    );

    const selection = router.selectForNewSession({
      excludeAccountIds: ["codex-pro-1", "codex-pro-2"]
    });

    expect("upstreamAccount" in selection && selection.upstreamAccount.id).toBe("codex-pro-3");
  });

  it("enforces maxConcurrent without queueing inside the router", () => {
    const router = new UpstreamAccountRouter([
      runtime("codex-pro-1", { maxConcurrent: 2 })
    ]);

    const first = router.beginStateless({ affinityKey: "credential-a" });
    const second = router.beginStateless({ affinityKey: "credential-b" });
    const third = router.beginStateless({ affinityKey: "credential-c" });

    expect(first).not.toBeInstanceOf(Error);
    expect(second).not.toBeInstanceOf(Error);
    expect(third).toMatchObject({
      code: "rate_limited"
    });

    if (!("release" in first)) {
      throw new Error("expected first lease");
    }
    first.release();

    const afterRelease = router.beginStateless({ affinityKey: "credential-c" });
    expect(afterRelease).not.toBeInstanceOf(Error);
    if ("release" in second) {
      second.release();
    }
    if ("release" in afterRelease) {
      afterRelease.release();
    }
  });

  it("makes an account selectable again after cooldown expires", () => {
    const account = upstreamAccount("codex-pro-1", {
      cooldownUntil: new Date(Date.now() + 60_000)
    });
    const router = new UpstreamAccountRouter([
      {
        upstreamAccount: account,
        provider: new FakeProvider(),
        maxConcurrent: 1
      }
    ]);

    expect(router.selectForNewSession()).toMatchObject({
      code: "rate_limited"
    });

    account.cooldownUntil = new Date(Date.now() - 1_000);
    const selection = router.selectForNewSession();
    expect(selection).not.toBeInstanceOf(Error);
    expect("upstreamAccount" in selection && selection.upstreamAccount.id).toBe("codex-pro-1");
  });

  it("records provider outcomes into account state and cooldown", () => {
    const updates: UpstreamAccount[] = [];
    const now = new Date("2026-01-01T00:00:00.000Z");
    const router = new UpstreamAccountRouter([runtime("codex-pro-1")], {
      cooldown: {
        rateLimitSeconds: 120,
        reauthSeconds: 900,
        serviceErrorSeconds: 30
      },
      now: () => now,
      onAccountUpdated: (account) => updates.push({ ...account })
    });

    const reauth = router.recordOutcome("codex-pro-1", "provider_reauth_required");
    expect(reauth).toMatchObject({
      state: "reauth_required",
      cooldownUntil: new Date("2026-01-01T00:15:00.000Z")
    });
    expect(router.selectForNewSession()).toMatchObject({
      code: "provider_reauth_required"
    });

    const success = router.recordOutcome("codex-pro-1", "success");
    expect(success).toMatchObject({
      state: "active",
      lastUsedAt: now,
      cooldownUntil: null
    });
    expect(updates.map((account) => account.state)).toEqual(["reauth_required", "active"]);
  });

  it("selects only image-capable accounts and tracks image inflight separately", () => {
    const router = new UpstreamAccountRouter([
      runtime("codex-pro-1", {
        maxConcurrent: 1,
        imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_A",
        imageProvider: new FakeImageGenerationProvider()
      })
    ]);

    const image = router.beginImage({ affinityKey: "credential-a" });
    const codex = router.beginStateless({ affinityKey: "credential-a" });
    const secondImage = router.beginImage({ affinityKey: "credential-b" });

    expect(image).not.toBeInstanceOf(Error);
    expect(codex).not.toBeInstanceOf(Error);
    expect(secondImage).toMatchObject({ code: "rate_limited" });

    if ("release" in image) {
      image.release();
    }
    if ("release" in codex) {
      codex.release();
    }
  });

  it("marks key_invalid image outcomes as terminal until restart", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const router = new UpstreamAccountRouter(
      [
        runtime("codex-pro-1", {
          imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_A",
          imageProvider: new FakeImageGenerationProvider()
        })
      ],
      {
        now: () => now,
        cooldown: {
          rateLimitSeconds: 120,
          reauthSeconds: 900,
          serviceErrorSeconds: 30
        }
      }
    );

    router.recordImageOutcome("codex-pro-1", "key_invalid");
    expect(router.beginImage()).toMatchObject({ code: "upstream_unavailable" });
    expect(router.selectForNewSession()).not.toBeInstanceOf(Error);
  });

  it("does not cooldown image accounts for content or invalid_request outcomes", () => {
    const router = new UpstreamAccountRouter([
      runtime("codex-pro-1", {
        imageApiKeyEnv: "MEDCODE_IMAGE_OPENAI_API_KEY_A",
        imageProvider: new FakeImageGenerationProvider()
      })
    ]);

    const noCooldownOutcomes: ImageProviderOutcome[] = [
      "content_policy_violation",
      "invalid_request"
    ];
    for (const outcome of noCooldownOutcomes) {
      router.recordImageOutcome("codex-pro-1", outcome);
      const lease = router.beginImage();
      expect(lease).not.toBeInstanceOf(Error);
      if ("release" in lease) {
        lease.release();
      }
    }
  });

  it("does not fall back to a non-eligible account for status", () => {
    const router = new UpstreamAccountRouter([
      runtime("codex-pro-1", { state: "reauth_required" })
    ]);

    expect(router.selectForStatus()).toMatchObject({
      code: "provider_reauth_required"
    });
  });

  it("returns sticky-session errors for disabled or reauth accounts", () => {
    const router = new UpstreamAccountRouter([
      runtime("codex-pro-1", { state: "disabled" }),
      runtime("codex-pro-2", { state: "reauth_required" }),
      runtime("codex-pro-3", { enabled: false })
    ]);

    expect(router.beginExistingSession("codex-pro-1")).toMatchObject({
      code: "subscription_unavailable"
    });
    expect(router.beginExistingSession("codex-pro-2")).toMatchObject({
      code: "provider_reauth_required"
    });
    expect(router.beginExistingSession("codex-pro-3")).toMatchObject({
      code: "subscription_unavailable"
    });
  });

  it("does not let startup auth validation overwrite an existing non-active DB state", () => {
    const account = upstreamAccount("codex-pro-1", { state: "disabled" });
    const applied = applyStartupAuthState(account, accountConfig("codex-pro-1", "Z:\\missing"), {
      validateAuthFiles: true
    });

    expect(applied.state).toBe("disabled");
  });
});

function accountConfig(id: string, codexHome: string) {
  return {
    id,
    label: id,
    provider: "openai-codex" as const,
    codexHome,
    enabled: true,
    initialState: "active" as const,
    weight: 1,
    maxConcurrent: 1
  };
}

function runtime(
  id: string,
  overrides: Partial<
    UpstreamAccountRuntimeInput & {
      state: UpstreamAccount["state"];
      imageApiKeyEnv: string | null;
    }
  > = {}
): UpstreamAccountRuntimeInput {
  return {
    upstreamAccount: upstreamAccount(id, {
      state: overrides.state,
      imageApiKeyEnv: overrides.imageApiKeyEnv
    }),
    provider: overrides.provider ?? new FakeProvider(),
    imageProvider: overrides.imageProvider,
    enabled: overrides.enabled,
    weight: overrides.weight,
    maxConcurrent: overrides.maxConcurrent ?? 1
  };
}

function upstreamAccount(
  id: string,
  overrides: Partial<UpstreamAccount> = {}
): UpstreamAccount {
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
