import { describe, expect, it } from "vitest";
import {
  extractAccessCredentialPrefix,
  hashAccessCredential,
  issueAccessCredential,
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
    expect(extractAccessCredentialPrefix(issued.token)).toBe(issued.record.prefix);
    expect(
      verifyAccessCredentialToken(issued.token, issued.record, new Date("2026-01-01T00:00:00Z"))
    ).toBeNull();
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
});
