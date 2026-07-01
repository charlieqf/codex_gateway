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
});
