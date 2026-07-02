import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openAIModelObject,
  resolvePublicModelRegistry
} from "./public-model-registry.js";

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
});
