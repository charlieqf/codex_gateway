import { describe, expect, it } from "vitest";
import {
  desktopSupportsR760MedevidenceOrigin,
  phoneAuthLegacyMedevidenceOrigin,
  phoneAuthR760MedevidenceOrigin,
  resolveMedevidenceOriginPolicy,
  selectMedevidenceOrigin
} from "./medevidence-origin-policy.js";

describe("MedEvidence origin policy", () => {
  it("defaults to the legacy origin until a fixed Desktop version is configured", () => {
    const policy = resolveMedevidenceOriginPolicy({});

    expect(policy).toEqual({
      mode: "legacy_only",
      r760MinimumDesktopVersion: null
    });
    expect(
      selectMedevidenceOrigin(
        phoneAuthLegacyMedevidenceOrigin,
        "99.0.0",
        policy
      )
    ).toBe(phoneAuthLegacyMedevidenceOrigin);
  });

  it("selects R760 only for strict SemVer clients at or above the configured version", () => {
    const policy = resolveMedevidenceOriginPolicy({
      GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION: "2.0.0-beta.47"
    });

    for (const version of [null, "invalid", "2.0.0-beta.46"]) {
      expect(desktopSupportsR760MedevidenceOrigin(version, policy)).toBe(false);
      expect(
        selectMedevidenceOrigin(
          phoneAuthR760MedevidenceOrigin,
          version,
          policy
        )
      ).toBe(phoneAuthLegacyMedevidenceOrigin);
    }
    for (const version of ["2.0.0-beta.47", "2.0.0", "2.1.0"]) {
      expect(desktopSupportsR760MedevidenceOrigin(version, policy)).toBe(true);
      expect(
        selectMedevidenceOrigin(
          phoneAuthLegacyMedevidenceOrigin,
          version,
          policy
        )
      ).toBe(phoneAuthR760MedevidenceOrigin);
    }
  });

  it("fails startup configuration for a malformed cutover version", () => {
    expect(() =>
      resolveMedevidenceOriginPolicy({
        GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION: "beta.47"
      })
    ).toThrow(
      "GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION must be a strict SemVer"
    );
  });

  it("does not rewrite non-Gateway-managed metadata", () => {
    const policy = resolveMedevidenceOriginPolicy({
      GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION: "2.0.0-beta.47"
    });

    expect(
      selectMedevidenceOrigin(
        "https://customer-managed.example",
        "2.0.0-beta.47",
        policy
      )
    ).toBe("https://customer-managed.example");
    expect(selectMedevidenceOrigin(null, "2.0.0-beta.47", policy)).toBeNull();
  });

  it("routes missing metadata only when the resolver identifies a Gateway-managed key", () => {
    const policy = resolveMedevidenceOriginPolicy({
      GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION: "2.0.0-beta.47"
    });

    expect(
      selectMedevidenceOrigin(null, "2.0.0-beta.46", policy, true)
    ).toBe(phoneAuthLegacyMedevidenceOrigin);
    expect(
      selectMedevidenceOrigin(null, "2.0.0-beta.47", policy, true)
    ).toBe(phoneAuthR760MedevidenceOrigin);
  });
});
