import { describe, expect, it } from "vitest";
import {
  credentialAllowsPublicModel,
  decodeStoredAllowedPublicModelsJson,
  extractAccessCredentialPrefix,
  hashAccessCredential,
  issueAccessCredential,
  issueUnifiedClientKey,
  extractUnifiedClientKeyPrefix,
  verifyUnifiedClientKeyToken,
  verifyAccessCredentialToken,
  type AccessCredentialRecord
} from "./index.js";

describe("access credentials", () => {
  it("issues opaque tokens with a verifiable stored hash", () => {
    const issued = issueAccessCredential({
      subjectId: "subj_1",
      label: "test",
      scope: "code",
      expiresAt: new Date("2026-01-02T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });

    expect(issued.token).toMatch(/^cgw\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(issued.record.prefix).toMatch(/^[A-Za-z0-9]/);
    expect(issued.record.hash).toBe(hashAccessCredential(issued.token));
    expect(issued.record.hash).not.toContain(issued.token);
    expect(issued.record.allowedPublicModels).toBeNull();
    expect(extractAccessCredentialPrefix(issued.token)).toBe(issued.record.prefix);
    expect(
      verifyAccessCredentialToken(issued.token, issued.record, new Date("2026-01-01T00:00:00Z"))
    ).toBeNull();
  });

  it("validates and copies explicit public model allowlists", () => {
    const allowedPublicModels = ["max"];
    const issued = issueAccessCredential({
      subjectId: "subj_1",
      label: "research",
      scope: "code",
      expiresAt: new Date("2026-01-02T00:00:00Z"),
      allowedPublicModels,
      knownPublicModelIds: ["max", "standard"],
      now: new Date("2026-01-01T00:00:00Z")
    });

    allowedPublicModels.push("standard");
    expect(issued.record.allowedPublicModels).toEqual(["max"]);
    expect(() =>
      issueAccessCredential({
        subjectId: "subj_1",
        label: "unknown model",
        scope: "code",
        expiresAt: new Date("2026-01-02T00:00:00Z"),
        allowedPublicModels: ["unknown"],
        knownPublicModelIds: ["max"],
        now: new Date("2026-01-01T00:00:00Z")
      })
    ).toThrow("Unknown public model id 'unknown'.");
    expect(() =>
      issueAccessCredential({
        subjectId: "subj_1",
        label: "duplicate model",
        scope: "code",
        expiresAt: new Date("2026-01-02T00:00:00Z"),
        allowedPublicModels: ["max", "max"],
        knownPublicModelIds: ["max"],
        now: new Date("2026-01-01T00:00:00Z")
      })
    ).toThrow("must not contain duplicate");
    expect(() =>
      issueAccessCredential({
        subjectId: "subj_1",
        label: "unchecked model",
        scope: "code",
        expiresAt: new Date("2026-01-02T00:00:00Z"),
        allowedPublicModels: ["max"],
        now: new Date("2026-01-01T00:00:00Z")
      })
    ).toThrow("knownPublicModelIds is required");

    const aliasIssued = issueAccessCredential({
      subjectId: "subj_1",
      label: "alias model",
      scope: "code",
      expiresAt: new Date("2026-01-02T00:00:00Z"),
      allowedPublicModels: ["medcode"],
      knownPublicModelIds: ["max", "standard"],
      publicModelAliases: [{ id: "max", aliases: ["medcode"] }],
      now: new Date("2026-01-01T00:00:00Z")
    });
    expect(aliasIssued.record.allowedPublicModels).toEqual(["max"]);
    expect(
      credentialAllowsPublicModel(
        ["medcode"],
        "max",
        [{ id: "max", aliases: ["medcode"] }]
      )
    ).toBe(true);
    expect(() =>
      issueAccessCredential({
        subjectId: "subj_1",
        label: "duplicate alias",
        scope: "code",
        expiresAt: new Date("2026-01-02T00:00:00Z"),
        allowedPublicModels: ["max", "medcode"],
        knownPublicModelIds: ["max"],
        publicModelAliases: [{ id: "max", aliases: ["medcode"] }]
      })
    ).toThrow("duplicate canonical model ids");
    expect(decodeStoredAllowedPublicModelsJson('["max"]')).toEqual(["max"]);
    expect(decodeStoredAllowedPublicModelsJson("[]")).toEqual([]);
    expect(decodeStoredAllowedPublicModelsJson("not-json")).toEqual([]);
  });

  it("rejects invalid, expired, and revoked tokens", () => {
    const issued = issueAccessCredential({
      subjectId: "subj_1",
      label: "test",
      scope: "code",
      expiresAt: new Date("2026-01-02T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });

    const invalid = verifyAccessCredentialToken(
      `${issued.token}x`,
      issued.record,
      new Date("2026-01-01T00:00:00Z")
    );
    expect(invalid?.code).toBe("invalid_credential");

    const expired = verifyAccessCredentialToken(
      issued.token,
      issued.record,
      new Date("2026-01-02T00:00:00Z")
    );
    expect(expired?.code).toBe("expired_credential");

    const revoked: AccessCredentialRecord = {
      ...issued.record,
      revokedAt: new Date("2026-01-01T12:00:00Z")
    };
    expect(
      verifyAccessCredentialToken(`${issued.token}x`, revoked, new Date("2026-01-01T13:00:00Z"))
        ?.code
    ).toBe("invalid_credential");
    expect(
      verifyAccessCredentialToken(issued.token, revoked, new Date("2026-01-01T13:00:00Z"))?.code
    ).toBe("revoked_credential");
  });

  it("raises explicit per-minute token limits to the system minimum", () => {
    const issued = issueAccessCredential({
      subjectId: "subj_1",
      label: "minimum token rate",
      scope: "code",
      expiresAt: new Date("2026-01-02T00:00:00Z"),
      rate: {
        token: {
          tokensPerMinute: 100_000,
          tokensPerDay: 5_000_000,
          tokensPerMonth: 100_000_000,
          maxPromptTokensPerRequest: 200_000,
          maxTotalTokensPerRequest: 300_000,
          reserveTokensPerRequest: 0,
          missingUsageCharge: "none"
        }
      },
      now: new Date("2026-01-01T00:00:00Z")
    });

    expect(issued.record.rate.token?.tokensPerMinute).toBe(300_000);
  });

  it("issues Gateway unified client keys without exposing embedded service credentials", () => {
    const issued = issueUnifiedClientKey({
      subjectId: "subj_1",
      label: "desktop handoff",
      expiresAt: new Date("2026-01-02T00:00:00Z"),
      codexCredentialId: "cred_1",
      codexCredentialPrefix: "codexprefix",
      codexKeyCiphertext: "v1.codex",
      medevidenceKeyCiphertext: "v1.medevidence",
      medevidenceKeyPrefix: "mev2prefix",
      now: new Date("2026-01-01T00:00:00Z")
    });

    expect(issued.token).toMatch(/^cgu_live_[A-Za-z0-9]{64}$/);
    expect(issued.record.prefix).toHaveLength(16);
    expect(extractUnifiedClientKeyPrefix(issued.token)).toBe(issued.record.prefix);
    expect(issued.record.hash).not.toContain(issued.token);
    expect(
      verifyUnifiedClientKeyToken(
        issued.token,
        issued.record,
        new Date("2026-01-01T00:00:00Z")
      )
    ).toBeNull();
    expect(
      verifyUnifiedClientKeyToken(
        `${issued.token}x`,
        issued.record,
        new Date("2026-01-01T00:00:00Z")
      )?.code
    ).toBe("invalid_credential");
  });
});
