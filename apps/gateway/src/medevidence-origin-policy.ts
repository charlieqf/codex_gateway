import {
  compareStrictSemVer,
  isStrictSemVer
} from "./desktop-version-gate.js";

export const phoneAuthLegacyMedevidenceOrigin =
  "https://gw-47-116-7-37.nip.io";
export const phoneAuthR760MedevidenceOrigin =
  "https://r760.instmarket.com.au:1443";

/**
 * Compatibility alias for persisted rows and callers that still treat the
 * pre-R760 origin as the default provisioning value.
 */
export const phoneAuthMedevidenceOrigin = phoneAuthLegacyMedevidenceOrigin;

export type MedevidenceOriginPolicyMode = "legacy_only" | "versioned";

export interface MedevidenceOriginPolicy {
  mode: MedevidenceOriginPolicyMode;
  r760MinimumDesktopVersion: string | null;
}

export function resolveMedevidenceOriginPolicy(
  env: NodeJS.ProcessEnv
): MedevidenceOriginPolicy {
  const minimumVersion =
    env.GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION?.trim() ?? "";
  if (!minimumVersion) {
    return {
      mode: "legacy_only",
      r760MinimumDesktopVersion: null
    };
  }
  if (!isStrictSemVer(minimumVersion)) {
    throw new Error(
      "GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION must be a strict SemVer when configured."
    );
  }
  return {
    mode: "versioned",
    r760MinimumDesktopVersion: minimumVersion
  };
}

export function isApprovedMedevidenceOrigin(
  value: string | null
): value is
  | typeof phoneAuthLegacyMedevidenceOrigin
  | typeof phoneAuthR760MedevidenceOrigin {
  return (
    value === phoneAuthLegacyMedevidenceOrigin ||
    value === phoneAuthR760MedevidenceOrigin
  );
}

export function desktopSupportsR760MedevidenceOrigin(
  clientVersion: string | null,
  policy: MedevidenceOriginPolicy
): boolean {
  return Boolean(
    clientVersion &&
      policy.r760MinimumDesktopVersion &&
      compareStrictSemVer(
        clientVersion,
        policy.r760MinimumDesktopVersion
      ) >= 0
  );
}

/**
 * Only approved Gateway-managed origins participate in version routing.
 * A Gateway-managed MedEvidence key may opt into the same controlled routing
 * when its older persisted row has no origin metadata. Other null/unknown
 * records retain their existing behavior.
 */
export function selectMedevidenceOrigin(
  storedOrigin: string | null,
  clientVersion: string | null,
  policy: MedevidenceOriginPolicy,
  routeMissingGatewayMetadata = false
): string | null {
  if (storedOrigin === null && !routeMissingGatewayMetadata) {
    return null;
  }
  if (storedOrigin !== null && !isApprovedMedevidenceOrigin(storedOrigin)) {
    return storedOrigin;
  }
  return desktopSupportsR760MedevidenceOrigin(clientVersion, policy)
    ? phoneAuthR760MedevidenceOrigin
    : phoneAuthLegacyMedevidenceOrigin;
}
