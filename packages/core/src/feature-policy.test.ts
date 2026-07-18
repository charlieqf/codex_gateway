import { describe, expect, it } from "vitest";
import {
  decodeStoredFeaturePolicy,
  publicFeaturePolicy,
  validateFeaturePolicy
} from "./feature-policy.js";

describe("feature policy", () => {
  it("preserves medcode_models through validation and public serialization", () => {
    const policy = validateFeaturePolicy({
      capabilities: ["chat", "tools"],
      medcode_models: {
        allowed: ["standard", "expert", "pro", "medcode"]
      }
    });

    expect(policy.medcodeModels).toEqual({
      allowed: ["standard", "expert", "pro", "medcode"]
    });
    expect(publicFeaturePolicy(policy)).toEqual({
      capabilities: ["chat", "tools"],
      medcode_models: {
        allowed: ["standard", "expert", "pro", "medcode"]
      }
    });
  });

  it("keeps legacy feature policies valid without medcode_models", () => {
    const policy = validateFeaturePolicy({
      capabilities: ["chat", "tools"]
    });

    expect(policy.medcodeModels).toBeNull();
    expect(publicFeaturePolicy(policy)).toEqual({
      capabilities: ["chat", "tools"]
    });
  });

  it("includes all public chat models in medcode_models output for compatibility", () => {
    const policy = validateFeaturePolicy({
      capabilities: ["chat", "tools"],
      medcode_models: {
        allowed: ["standard"]
      }
    });

    expect(policy.medcodeModels).toEqual({ allowed: ["standard"] });
    expect(publicFeaturePolicy(policy)).toMatchObject({
      medcode_models: {
        allowed: ["standard", "medcode", "expert", "pro"]
      }
    });
  });

  it("accepts doctor_research while preserving and rejecting truly future capabilities at the correct boundaries", () => {
    const stored = {
      capabilities: ["chat", "doctor_research", "future_capability"]
    };

    const decoded = decodeStoredFeaturePolicy(stored);
    expect(decoded.capabilities).toEqual([
      "chat",
      "doctor_research",
      "future_capability"
    ]);
    expect(publicFeaturePolicy(decoded)).toEqual(stored);
    expect(
      validateFeaturePolicy({
        capabilities: ["chat", "doctor_research"]
      }).capabilities
    ).toEqual(["chat", "doctor_research"]);
    expect(() => validateFeaturePolicy(stored)).toThrow(
      "Unsupported feature capability: future_capability"
    );
  });
});
