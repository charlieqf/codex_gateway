import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeStoredFeaturePolicy,
  publicFeaturePolicy,
  validateFeaturePolicy
} from "./feature-policy.js";

interface CompatibilityFixture {
  schema_version: string;
  minimum_rollback: {
    source_commit: string;
    image_digest: string;
  };
  production_read_probe: {
    policy_rows_decoded: number;
    research_api_enabled: boolean;
    contains_production_values: boolean;
  };
  stored_policy_snapshots: Array<{
    id: string;
    stored_policy: unknown;
    expected_public_policy: unknown;
  }>;
  forward_compatibility_probe: {
    stored_policy: {
      capabilities: string[];
    };
    strict_writer_policy: {
      capabilities: string[];
    };
    strict_rejected_capability: string;
  };
}

const compatibilityFixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/phase0.5-compatibility.v1.json",
      import.meta.url
    ),
    "utf8"
  )
) as CompatibilityFixture;

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

  it("passes the frozen Doctor Research Phase 0.5 compatibility gate", () => {
    expect(compatibilityFixture.schema_version).toBe(
      "doctor_research_phase0_5_compatibility.v1"
    );
    expect(compatibilityFixture.minimum_rollback.source_commit).toMatch(
      /^[0-9a-f]{40}$/
    );
    expect(compatibilityFixture.minimum_rollback.image_digest).toMatch(
      /^sha256:[0-9a-f]{64}$/
    );
    expect(compatibilityFixture.production_read_probe).toMatchObject({
      policy_rows_decoded: expect.any(Number),
      research_api_enabled: false,
      contains_production_values: false
    });
    expect(
      compatibilityFixture.production_read_probe.policy_rows_decoded
    ).toBeGreaterThan(0);

    for (const snapshot of compatibilityFixture.stored_policy_snapshots) {
      expect(
        publicFeaturePolicy(decodeStoredFeaturePolicy(snapshot.stored_policy)),
        snapshot.id
      ).toEqual(snapshot.expected_public_policy);
    }

    const probe = compatibilityFixture.forward_compatibility_probe;
    const decoded = decodeStoredFeaturePolicy(probe.stored_policy);
    expect(decoded.capabilities).toEqual(probe.stored_policy.capabilities);
    expect(publicFeaturePolicy(decoded)).toEqual(probe.stored_policy);
    expect(
      validateFeaturePolicy(probe.strict_writer_policy).capabilities
    ).toEqual(probe.strict_writer_policy.capabilities);
    expect(() => validateFeaturePolicy(probe.stored_policy)).toThrow(
      `Unsupported feature capability: ${probe.strict_rejected_capability}`
    );
  });
});
