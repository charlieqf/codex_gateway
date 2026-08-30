import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openAIModelObject,
  providerReasoningSettings,
  resolvePublicModelRegistry
} from "./public-model-registry.js";
import { goldencodePoolConfig } from "../test-support.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("public model registry", () => {
  it("defaults to the legacy medcode model and limits", () => {
    const registry = resolvePublicModelRegistry({});

    expect(registry.listAvailable({ openRouterAvailable: false }).map(openAIModelObject)).toEqual([
      {
        id: "medcode",
        object: "model",
        created: 0,
        owned_by: "medcode",
        context_window: 400000,
        max_context_window: 400000,
        max_output_tokens: 128000
      }
    ]);
  });

  it("uses file registry before env registry", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-model-registry-"));
    cleanupDirs.push(dir);
    const registryPath = path.join(dir, "public-models.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        max: {
          displayName: "Max",
          aliases: ["medcode"],
          runtime: "codex",
          upstreamModel: "gpt-5.5",
          contextWindow: 400000,
          maxOutputTokens: 128000
        },
        expert: {
          displayName: "Expert",
          runtime: "openrouter",
          upstreamModel: "z-ai/glm-5.2",
          contextWindow: 200000,
          upstreamContextWindow: 1048576,
          enabled: true,
          reasoning: { effort: "high" }
        },
        standard: {
          displayName: "Standard",
          runtime: "openrouter",
          upstreamModel: "deepseek/deepseek-v4-pro",
          contextWindow: 200000,
          enabled: true,
          reasoning: { effort: "none" }
        }
      })
    );

    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON_FILE: registryPath,
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        pro: {
          runtime: "openrouter",
          upstreamModel: "z-ai/glm-5.2",
          enabled: true
        }
      })
    });

    expect(registry.models.map((model) => model.id)).toEqual(["max", "expert", "standard"]);
    expect(registry.get("medcode")?.id).toBe("max");
    expect(registry.listAvailable({ openRouterAvailable: false }).map((model) => model.id)).toEqual([
      "max"
    ]);
    expect(registry.listAvailable({ openRouterAvailable: true }).map((model) => model.id)).toEqual([
      "max",
      "expert",
      "standard"
    ]);
    expect(registry.get("expert")?.reasoning).toEqual({ effort: "high" });
    expect(openAIModelObject(registry.get("standard")!)).toMatchObject({
      id: "standard",
      context_window: 200000,
      max_context_window: 200000,
      max_output_tokens: 128000
    });
  });

  it("parses model-level reasoning capabilities and strips them from provider settings", () => {
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        goldencode: {
          displayName: "GoldenCode",
          runtime: "tencent",
          upstreamModel: "glm-5.3",
          reasoning: {
            effort: "high",
            supportedEfforts: ["low", "high", "max"],
            legacyAliases: { none: "low", medium: "high" }
          }
        }
      })
    });

    const reasoning = registry.get("goldencode")?.reasoning;
    expect(reasoning).toEqual({
      effort: "high",
      supportedEfforts: ["low", "high", "max"],
      legacyAliases: { none: "low", medium: "high" }
    });
    expect(providerReasoningSettings(reasoning)).toEqual({ effort: "high" });
  });

  it("rejects inconsistent reasoning capability declarations at startup", () => {
    expect(() =>
      resolvePublicModelRegistry({
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
          goldencode: {
            runtime: "tencent",
            upstreamModel: "glm-5.3",
            reasoning: {
              effort: "medium",
              supportedEfforts: ["low", "high", "max"]
            }
          }
        })
      })
    ).toThrow("reasoning.effort must be included in supportedEfforts");

    expect(() =>
      resolvePublicModelRegistry({
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
          goldencode: {
            runtime: "tencent",
            upstreamModel: "glm-5.3",
            reasoning: {
              effort: "high",
              supportedEfforts: ["low", "high", "max"],
              legacyAliases: { medium: "xhigh" }
            }
          }
        })
      })
    ).toThrow("legacyAliases target 'xhigh' must be included in supportedEfforts");
  });

  it("rejects aliases that collide with public model ids", () => {
    expect(() =>
      resolvePublicModelRegistry({
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
          max: {
            aliases: ["standard"],
            runtime: "codex",
            upstreamModel: "gpt-5.5"
          },
          standard: {
            runtime: "openrouter",
            upstreamModel: "deepseek/deepseek-v4-pro"
          }
        })
      })
    ).toThrow("Duplicate public model id or alias 'standard'");
  });

  it("exposes qianfan models only when the qianfan runtime is configured", () => {
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        max: {
          aliases: ["medcode"],
          runtime: "codex",
          upstreamModel: "gpt-5.5"
        },
        expert: {
          runtime: "qianfan",
          upstreamModel: "glm-5.2",
          reasoning: { effort: "medium" }
        },
        pro: {
          runtime: "openrouter",
          upstreamModel: "z-ai/glm-5-turbo"
        }
      })
    });

    expect(
      registry
        .listAvailable({ openRouterAvailable: true, qianfanAvailable: false })
        .map((model) => model.id)
    ).toEqual(["max", "pro"]);
    expect(
      registry
        .listAvailable({ openRouterAvailable: false, qianfanAvailable: true })
        .map((model) => model.id)
    ).toEqual(["max", "expert"]);
    expect(registry.get("expert")?.runtime).toBe("qianfan");
    expect(registry.get("expert")?.reasoning).toEqual({ effort: "medium" });
  });

  it("exposes aliyun and tencent models only when those runtimes are configured", () => {
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        max: {
          aliases: ["medcode"],
          runtime: "codex",
          upstreamModel: "gpt-5.5"
        },
        advisor: {
          displayName: "Advisor",
          runtime: "aliyun",
          upstreamModel: "glm-5.2",
          reasoning: { effort: "none" }
        },
        consultant: {
          displayName: "Consultant",
          runtime: "tencent",
          upstreamModel: "glm-5.2",
          reasoning: { effort: "none" }
        }
      })
    });

    expect(
      registry
        .listAvailable({
          openRouterAvailable: false,
          aliyunAvailable: true,
          tencentAvailable: false
        })
        .map((model) => model.id)
    ).toEqual(["max", "advisor"]);
    expect(
      registry
        .listAvailable({
          openRouterAvailable: false,
          aliyunAvailable: false,
          tencentAvailable: true
        })
        .map((model) => model.id)
    ).toEqual(["max", "consultant"]);
    expect(registry.get("advisor")?.runtime).toBe("aliyun");
    expect(registry.get("consultant")?.runtime).toBe("tencent");
  });

  it("parses an isolated local OpenAI-compatible model and gates availability", () => {
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODEL_ID: "qwen3.8-27b-fp8",
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        "qwen3.8-27b-fp8": {
          displayName: "Qwen3.8 27B FP8 (R760)",
          runtime: "local_openai",
          upstreamModel: "qwen3.8-27b-fp8",
          contextWindow: 32768,
          maxContextWindow: 32768,
          upstreamContextWindow: 65536,
          maxOutputTokens: 8192,
          enabled: true
        }
      })
    });

    expect(registry.get("qwen3.8-27b-fp8")).toMatchObject({
      runtime: "local_openai",
      contextWindow: 32768,
      maxOutputTokens: 8192
    });
    expect(openAIModelObject(registry.get("qwen3.8-27b-fp8")!)).toMatchObject({
      context_window: 32768,
      max_output_tokens: 8192,
      context_error_contract_version: 1,
      context_overflow_recovery: "compact_and_retry_once"
    });
    expect(
      registry
        .listAvailable({ openRouterAvailable: false, localOpenAIAvailable: false })
        .map((model) => model.id)
    ).toEqual([]);
    expect(
      registry
        .listAvailable({ openRouterAvailable: false, localOpenAIAvailable: true })
        .map((model) => model.id)
    ).toEqual(["qwen3.8-27b-fp8"]);
  });

  it("parses pool models and checks availability by member adapters", () => {
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        max: {
          aliases: ["medcode"],
          runtime: "codex",
          upstreamModel: "gpt-5.5"
        },
        goldencode: goldencodePoolConfig()
      })
    });
    const goldencode = registry.get("goldencode");

    expect(goldencode).toMatchObject({
      id: "goldencode",
      displayName: "GoldenCode",
      runtime: "pool",
      upstreamModel: "glm-5.2",
      reasoning: { effort: "medium" }
    });
    expect(goldencode?.pool).toMatchObject({
      requireAllMembers: true,
      selection: {
        strategy: "hrw_sticky",
        stickyKeyOrder: ["client_session", "credential", "subject"]
      }
    });
    expect(goldencode?.pool?.members.map((member) => member.id)).toEqual([
      "goldencode-qianfan",
      "goldencode-tencent",
      "goldencode-tokenswitch",
      "goldencode-aliyun",
      "goldencode-openrouter"
    ]);
    expect(
      registry
        .listAvailable({
          openRouterAvailable: false,
          qianfanAvailable: false,
          aliyunAvailable: false,
          tencentAvailable: false,
          poolMemberAdapterKeys: new Set([
            "qianfan:goldencode-qianfan",
            "tencent:goldencode-tencent",
            "tokenswitch:goldencode-tokenswitch",
            "aliyun:goldencode-aliyun",
            "openrouter:goldencode-openrouter"
          ])
        })
        .map((model) => model.id)
    ).toEqual(["max", "goldencode"]);
    expect(openAIModelObject(goldencode!)).toEqual({
      id: "goldencode",
      object: "model",
      created: 0,
      owned_by: "medcode",
      context_window: 200000,
      max_context_window: 200000,
      max_output_tokens: 128000
    });
  });

  it("parses an independent xAI vision route without changing the text pool", () => {
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        goldencode: {
          ...goldencodePoolConfig(),
          vision: {
            runtime: "xai",
            upstreamModel: "grok-4.5",
            contextWindow: 200000,
            maxOutputTokens: 128000,
            reasoning: { effort: "medium" }
          }
        }
      })
    });

    const model = registry.get("goldencode");
    expect(model?.runtime).toBe("pool");
    expect(model?.pool?.members[0].upstreamModel).toBe("glm-5.2");
    expect(model?.vision).toEqual({
      runtime: "xai",
      upstreamModel: "grok-4.5",
      contextWindow: 200000,
      maxOutputTokens: 128000,
      reasoning: { effort: "medium" },
      enabled: true
    });
  });

  it("rejects unsupported public-model vision runtimes", () => {
    expect(() =>
      resolvePublicModelRegistry({
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
          goldencode: {
            ...goldencodePoolConfig(),
            vision: {
              runtime: "gemini",
              upstreamModel: "gemini-flash"
            }
          }
        })
      })
    ).toThrow("vision.runtime must be xai");
  });

  it("requires every enabled pool member when requireAllMembers is true", () => {
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        max: {
          aliases: ["medcode"],
          runtime: "codex",
          upstreamModel: "gpt-5.5"
        },
        goldencode: goldencodePoolConfig()
      })
    });

    expect(
      registry
        .listAvailable({
          openRouterAvailable: true,
          qianfanAvailable: true,
          aliyunAvailable: true,
          tencentAvailable: true,
          poolMemberAdapterKeys: new Set([
            "qianfan:goldencode-qianfan",
            "tencent:goldencode-tencent",
            "aliyun:goldencode-aliyun"
          ])
        })
        .map((model) => model.id)
    ).toEqual(["max"]);
  });

  it("defaults pool model reasoning effort to medium", () => {
    const goldencode = goldencodePoolConfig() as unknown as Record<string, unknown>;
    delete goldencode.reasoning;
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        goldencode
      })
    });

    expect(registry.get("goldencode")?.reasoning).toEqual({ effort: "medium" });
  });

  it("does not satisfy pool availability from a same-named adapter in another runtime", () => {
    const config = goldencodePoolConfig();
    config.pool.members = [
      {
        id: "shared-member",
        runtime: "qianfan",
        upstreamModel: "glm-5.2"
      }
    ];
    config.pool.requireAllMembers = true;
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        goldencode: config
      })
    });

    expect(
      registry
        .listAvailable({
          openRouterAvailable: true,
          qianfanAvailable: false,
          poolMemberAdapterKeys: new Set(["openrouter:shared-member"])
        })
        .map((model) => model.id)
    ).toEqual(["medcode"]);
    expect(
      registry
        .listAvailable({
          openRouterAvailable: false,
          qianfanAvailable: false,
          poolMemberAdapterKeys: new Set(["qianfan:shared-member"])
        })
        .map((model) => model.id)
    ).toEqual(["medcode", "goldencode"]);
  });

  it("parses a pool with all members disabled without exposing it", () => {
    const config = goldencodePoolConfig();
    config.pool.members = config.pool.members.map((member) => ({
      ...member,
      enabled: false
    }));
    const registry = resolvePublicModelRegistry({
      MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
        goldencode: config
      })
    });

    expect(registry.get("goldencode")?.upstreamModel).toBe("glm-5.2");
    expect(
      registry
        .listAvailable({
          openRouterAvailable: true,
          qianfanAvailable: true,
          aliyunAvailable: true,
          tencentAvailable: true,
          poolMemberAdapterKeys: new Set([
            "qianfan:goldencode-qianfan",
            "tencent:goldencode-tencent",
            "aliyun:goldencode-aliyun",
            "openrouter:goldencode-openrouter"
          ])
        })
        .map((model) => model.id)
    ).toEqual(["medcode"]);
  });

  it("does not accept unsupported pool member config", () => {
    expect(() =>
      resolvePublicModelRegistry({
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
          goldencode: {
            ...goldencodePoolConfig(),
            pool: {
              ...goldencodePoolConfig().pool,
              members: [
                {
                  id: "goldencode-codex",
                  runtime: "codex",
                  upstreamModel: "gpt-5.5"
                }
              ]
            }
          }
        })
      })
    ).toThrow("runtime must be openrouter, qianfan, aliyun, tencent, or tokenswitch");

    expect(() =>
      resolvePublicModelRegistry({
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
          goldencode: {
            ...goldencodePoolConfig(),
            pool: {
              ...goldencodePoolConfig().pool,
              members: [
                {
                  id: "goldencode-local",
                  runtime: "local_openai",
                  upstreamModel: "qwen3.8-27b-fp8"
                }
              ]
            }
          }
        })
      })
    ).toThrow("runtime must be openrouter, qianfan, aliyun, tencent, or tokenswitch");

    expect(() =>
      resolvePublicModelRegistry({
        MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
          goldencode: {
            ...goldencodePoolConfig(),
            pool: {
              ...goldencodePoolConfig().pool,
              members: [
                {
                  id: "goldencode-qianfan",
                  runtime: "qianfan",
                  upstreamModel: "glm-5.2",
                  weight: 2
                }
              ]
            }
          }
        })
      })
    ).toThrow("weight is not supported");
  });
});
