import { describe, expect, it } from "vitest";
import { validateTokenPolicy } from "./token-budget.js";

describe("validateTokenPolicy legacy snapshots", () => {
  it("accepts policies stored before tokensTotal existed and treats them as unlimited", () => {
    const legacy = {
      tokensPerMinute: 300_000,
      tokensPerDay: 10_000,
      tokensPerMonth: null,
      maxPromptTokensPerRequest: null,
      maxTotalTokensPerRequest: null,
      reserveTokensPerRequest: 0,
      missingUsageCharge: "estimate"
    } as Parameters<typeof validateTokenPolicy>[0];
    expect(validateTokenPolicy(legacy)).toMatchObject({ tokensTotal: null, tokensPerDay: 10_000 });
  });
});
