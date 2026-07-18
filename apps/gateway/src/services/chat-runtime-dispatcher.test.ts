import { describe, expect, it } from "vitest";
import {
  GatewayError,
  type GatewaySession,
  type MessageInput,
  type ProviderAdapter,
  type ProviderHealth,
  type StreamEvent,
  type Subject,
  type UpstreamAccount
} from "@codex-gateway/core";
import { resolvePublicModelRegistry, type PublicModelConfig } from "./public-model-registry.js";
import { createChatRuntimeDispatcher } from "./chat-runtime-dispatcher.js";
import { UpstreamAccountRouter, type UpstreamAccountRuntimeInput } from "./upstream-account-router.js";
import {
  goldencodePoolConfig,
  hrwAccountForKey,
  sessionIdForGoldencodeMember
} from "../test-support.js";

class FakeProvider implements ProviderAdapter {
  readonly kind = "fake";
  readonly messages: MessageInput[] = [];

  async health(_upstreamAccount: UpstreamAccount): Promise<ProviderHealth> {
    return {
      state: "healthy",
      checkedAt: new Date("2026-01-01T00:00:00Z")
    };
  }

  async *message(input: MessageInput): AsyncIterable<StreamEvent> {
    this.messages.push(input);
    yield { type: "completed" };
  }
}

const subject: Subject = {
  id: "subj_dev",
  label: "Subject",
  state: "active",
  createdAt: new Date("2026-01-01T00:00:00Z")
};

describe("chat runtime dispatcher pool runtime", () => {
  it("uses HRW sticky selection for pool members and records member attribution", () => {
    const model = goldencodeModel();
    const router = poolRouter(model);
    const dispatcher = createChatRuntimeDispatcher({
      codexRouter: poolRouter(model),
      openRouterAdapterForModel: () => null,
      poolRouterForModel: () => router
    });
    const affinityKey = "client_session:sticky-a";
    const expectedMemberId = hrwAccountForKey(
      affinityKey,
      model.pool!.members.map((member) => member.id)
    );

    const first = dispatcher.begin({
      model,
      reasoningEffort: "medium",
      reasoningEffortSource: "default",
      subject,
      scope: "code",
      affinityKey,
      createSession: createSession
    });
    const second = dispatcher.begin({
      model,
      reasoningEffort: "medium",
      reasoningEffortSource: "default",
      subject,
      scope: "code",
      affinityKey,
      createSession: createSession
    });

    expect(first).not.toBeInstanceOf(GatewayError);
    expect(second).not.toBeInstanceOf(GatewayError);
    if (first instanceof GatewayError || second instanceof GatewayError) {
      throw new Error("expected pool runtime contexts");
    }
    expect(first.publicModelId).toBe("goldencode");
    expect(first.runtimeInstanceId).toBe(expectedMemberId);
    expect(second.runtimeInstanceId).toBe(expectedMemberId);
    expect(first.adapterInputUpstreamAccount.id).toBe(expectedMemberId);
    expect(first.runtime).toBe(memberRuntime(model, expectedMemberId));
    expect(first.upstreamModel).toBe(memberUpstreamModel(model, expectedMemberId));

    first.release();
    second.release();
  });

  it("retries another member during cooldown and allows HRW to switch back afterward", () => {
    const model = goldencodeModel();
    const router = poolRouter(model);
    const dispatcher = createChatRuntimeDispatcher({
      codexRouter: poolRouter(model),
      openRouterAdapterForModel: () => null,
      poolRouterForModel: () => router
    });
    const affinityKey = "client_session:cooldown-a";
    const expectedMemberId = hrwAccountForKey(
      affinityKey,
      model.pool!.members.map((member) => member.id)
    );

    const first = dispatcher.begin({
      model,
      reasoningEffort: "medium",
      reasoningEffortSource: "default",
      subject,
      scope: "code",
      affinityKey,
      createSession: createSession
    });
    expect(first).not.toBeInstanceOf(GatewayError);
    if (first instanceof GatewayError) {
      throw new Error("expected first pool runtime context");
    }
    expect(first.runtimeInstanceId).toBe(expectedMemberId);
    expect(
      first.recordError(
        new GatewayError({
          code: "rate_limited",
          message: "limited",
          httpStatus: 429
        })
      )
    ).toBe(true);
    first.release();

    const retry = first.beginRetry!({
      excludeAccountIds: [first.runtimeInstanceId]
    });
    expect(retry).not.toBeInstanceOf(GatewayError);
    if (retry instanceof GatewayError) {
      throw new Error("expected retry pool runtime context");
    }
    expect(retry.runtimeInstanceId).not.toBe(expectedMemberId);
    retry.release();

    first.adapterInputUpstreamAccount.cooldownUntil = new Date(Date.now() - 1_000);
    const afterCooldown = dispatcher.begin({
      model,
      reasoningEffort: "medium",
      reasoningEffortSource: "default",
      subject,
      scope: "code",
      affinityKey,
      createSession: createSession
    });
    expect(afterCooldown).not.toBeInstanceOf(GatewayError);
    if (afterCooldown instanceof GatewayError) {
      throw new Error("expected after-cooldown pool runtime context");
    }
    expect(afterCooldown.runtimeInstanceId).toBe(expectedMemberId);
    afterCooldown.release();
  });

  it("uses member reasoning as the pool default and lets explicit requests override it", () => {
    const model = goldencodeModel();
    const qianfan = model.pool!.members.find((member) => member.id === "goldencode-qianfan");
    if (!qianfan) {
      throw new Error("expected qianfan pool member");
    }
    qianfan.reasoning = { effort: "high" };
    const router = poolRouter(model);
    const dispatcher = createChatRuntimeDispatcher({
      codexRouter: poolRouter(model),
      openRouterAdapterForModel: () => null,
      poolRouterForModel: () => router
    });
    const affinityKey = `client_session:${sessionIdForGoldencodeMember("goldencode-qianfan")}`;

    const defaulted = dispatcher.begin({
      model,
      reasoningEffort: "medium",
      reasoningEffortSource: "default",
      subject,
      scope: "code",
      affinityKey,
      createSession: createSession
    });
    const explicit = dispatcher.begin({
      model,
      reasoningEffort: "low",
      reasoningEffortSource: "request",
      subject,
      scope: "code",
      affinityKey,
      createSession: createSession
    });

    expect(defaulted).not.toBeInstanceOf(GatewayError);
    expect(explicit).not.toBeInstanceOf(GatewayError);
    if (defaulted instanceof GatewayError || explicit instanceof GatewayError) {
      throw new Error("expected pool runtime contexts");
    }
    expect(defaulted.reasoningEffort).toBe("high");
    expect(explicit.reasoningEffort).toBe("low");
    defaulted.release();
    explicit.release();
  });
});

function goldencodeModel(): PublicModelConfig {
  const registry = resolvePublicModelRegistry({
    MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
      max: {
        aliases: ["medcode"],
        runtime: "codex",
        upstreamModel: "gpt-5.5"
      },
      goldencode: {
        ...goldencodePoolConfig()
      }
    })
  });
  const model = registry.get("goldencode");
  if (!model) {
    throw new Error("expected goldencode model");
  }
  return model;
}

function poolRouter(model: PublicModelConfig): UpstreamAccountRouter {
  return new UpstreamAccountRouter(
    model.pool!.members.map(
      (member): UpstreamAccountRuntimeInput => ({
        upstreamAccount: {
          id: member.id,
          provider: member.runtime,
          label: member.id,
          credentialRef: `PUBLIC_MODEL_POOL:${model.id}:${member.id}`,
          state: "active",
          lastUsedAt: null,
          cooldownUntil: null
        },
        provider: new FakeProvider(),
        maxConcurrent: 10
      })
    ),
    {
      softAffinity: "credential",
      cooldown: {
        rateLimitSeconds: 120,
        reauthSeconds: 900,
        serviceErrorSeconds: 30
      }
    }
  );
}

function createSession(subjectId: string, upstreamAccountId: string): GatewaySession {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: `sess_${upstreamAccountId}`,
    subjectId,
    upstreamAccountId,
    publicModelId: null,
    providerSessionRef: null,
    title: null,
    state: "active",
    createdAt: now,
    updatedAt: now
  };
}

function memberRuntime(model: PublicModelConfig, memberId: string): string {
  return model.pool!.members.find((member) => member.id === memberId)!.runtime;
}

function memberUpstreamModel(model: PublicModelConfig, memberId: string): string {
  return model.pool!.members.find((member) => member.id === memberId)!.upstreamModel;
}
