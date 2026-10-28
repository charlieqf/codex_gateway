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
