import { describe, expect, it } from "vitest";
import { publicFeaturePolicy, validateFeaturePolicy } from "./feature-policy.js";

describe("feature policy", () => {
  it("preserves medcode_models through validation and public serialization", () => {
    const policy = validateFeaturePolicy({
      capabilities: ["chat", "tools"],
      medcode_models: {
        allowed: ["standard", "pro", "medcode"]
      }
    });

    expect(policy.medcodeModels).toEqual({
      allowed: ["standard", "pro", "medcode"]
    });
    expect(publicFeaturePolicy(policy)).toEqual({
      capabilities: ["chat", "tools"],
      medcode_models: {
        allowed: ["standard", "pro", "medcode"]
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

  it("includes medcode in public medcode_models output for v1 compatibility", () => {
    const policy = validateFeaturePolicy({
      capabilities: ["chat", "tools"],
      medcode_models: {
        allowed: ["standard"]
      }
    });

    expect(policy.medcodeModels).toEqual({ allowed: ["standard"] });
    expect(publicFeaturePolicy(policy)).toMatchObject({
      medcode_models: {
        allowed: ["standard", "medcode"]
      }
    });
  });
});
