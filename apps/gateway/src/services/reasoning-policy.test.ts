import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import { resolvePublicModelRegistry } from "./public-model-registry.js";
import { resolveChatCompletionReasoningEffort as resolve } from "./reasoning-policy.js";

function model(id: string, visionReasoning: unknown = { effort: "medium" }) {
  const config = JSON.parse(readFileSync(new URL("../../../../config/gateway.goldencode.three-provider.example.json", import.meta.url), "utf8"));
  config[id].vision.reasoning = visionReasoning;
  if (visionReasoning === null) delete config[id].vision.reasoning;
  return resolvePublicModelRegistry({ MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(config) }).get(id)!;
}

describe("public vision reasoning policy", () => {
  it.each(["goldencode", "goldencode-d"].flatMap(id =>
    [undefined, "none", "low", "medium", "high", "max"].map(tier => ({ id, tier }))))(
    "preserves the public contract for $id $tier and caps vision max", ({ id, tier }) => {
      const vision = resolve(model(id), tier, id, "vision");
      const text = resolve(model(id), tier, id, "text");
      const effective = tier === "none" || tier === "low" ? "low" : "high";
      expect(vision).toMatchObject({ requested: tier ?? null, effective,
        normalized: tier === "none" || tier === "medium" || tier === "max" });
      expect(text).toMatchObject({ effective: tier === "max" ? "max" : effective });
    });

  it("rejects an unsupported public tier before applying a vision capability cap", () => {
    expect(resolve(model("goldencode"), "xhigh", "goldencode", "vision")).toBeInstanceOf(GatewayError);
  });

  it("chooses the nearest lower tier and never upgrades a request or an alias", () => {
    const sparse = model("goldencode-d", { effort: "medium", supportedEfforts: ["none", "medium"] });
    expect(resolve(sparse, "low", sparse.id, "vision")).toMatchObject({ effective: "none" });
    expect(resolve(sparse, "high", sparse.id, "vision")).toMatchObject({ effective: "medium" });
    const upwardAlias = model("goldencode-d", { effort: "high", supportedEfforts: ["none", "high"], legacyAliases: { low: "high" } });
    expect(resolve(upwardAlias, "low", upwardAlias.id, "vision")).toMatchObject({ effective: "none" });
  });

  it.each(["low", undefined])("returns the complete recovery contract when no lower tier exists: %s", (requested) => {
    const sparse = model("goldencode-d", { effort: "medium", supportedEfforts: ["medium", "high"] });
    sparse.reasoning!.effort = "low";
    expect(resolve(sparse, requested, sparse.id, "vision")).toMatchObject({
      code: "unsupported_reasoning_effort", httpStatus: 400, contractVersion: 1,
      recommendedAction: "use_supported_reasoning_effort", recoveryOwner: "client",
      parameter: "reasoning_effort", requestedValue: "low", supportedValues: ["medium", "high"]
    });
  });

  it("uses vision capabilities for a Codex text runtime without an explicit vision list", () => {
    const codex = model("goldencode-d");
    codex.id = "custom-codex";
    codex.runtime = "codex";
    expect(resolve(codex, undefined, codex.id, "vision")).toMatchObject({ requested: null, effective: "high", source: "default" });
    expect(resolve(codex, "max", codex.id, "vision")).toMatchObject({ effective: "high", normalized: true });
  });

  it("respects explicit capability lists, snake-case aliases, and inherited reasoning", () => {
    const custom = model("goldencode-d", { effort: "xhigh", supported_efforts: ["low", "xhigh"] });
    expect(resolve(custom, "max", custom.id, "vision")).toMatchObject({ effective: "xhigh", normalizationReason: "vision_capability" });
    const native = model("goldencode-d", { effort: "high", supportedEfforts: ["low", "high", "max"] });
    expect(resolve(native, "max", native.id, "vision")).toMatchObject({ effective: "max", normalized: false });
    const alias = model("goldencode-d", { effort: "high", supported_efforts: ["low", "high"], legacy_aliases: { max: "low" } });
    expect(resolve(alias, "max", alias.id, "vision")).toMatchObject({ effective: "low" });
    const inherited = model("goldencode-d", null);
    expect(inherited.vision!.reasoning).toEqual(inherited.reasoning);
    expect(resolve(inherited, "max", inherited.id, "vision")).toMatchObject({ effective: "max", normalized: false });
  });
});
