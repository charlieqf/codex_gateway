import { GatewayError } from "@codex-gateway/core";
import { isApprovedMedevidenceOrigin } from "./medevidence-origin-policy.js";

/**
 * - valid: the selected MedEvidence service explicitly accepted the key.
 * - rejected: it explicitly refused the key (HTTP 401/403 or `valid: false`); the
 *   resolver must not hand out this origin/key pair.
 * - unverified: no definitive answer (timeout, network error, redirect, 429/5xx,
 *   malformed body). The resolver proceeds, so a MedEvidence outage limits
 *   MedEvidence features instead of blocking the Codex Gateway credential.
 */
export type MedevidenceRuntimeKeyResult =
  | { outcome: "valid" }
  | { outcome: "rejected"; error: GatewayError }
  | { outcome: "unverified"; reason: MedevidenceRuntimeKeyUnverifiedReason; status?: number };

export type MedevidenceRuntimeKeyUnverifiedReason =
  | "unapproved_origin"
  | "upstream_status"
  | "malformed_response"
  | "transport";

export type MedevidenceRuntimeKeyValidator = (
  baseUrl: string,
  apiKey: string
) => Promise<MedevidenceRuntimeKeyResult>;

/** Validate the exact origin/key pair, including rows with stale origin metadata. */
export function createMedevidenceRuntimeKeyValidator(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): MedevidenceRuntimeKeyValidator {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  return async (baseUrl, apiKey) => {
    if (!isApprovedMedevidenceOrigin(baseUrl)) {
      return { outcome: "unverified", reason: "unapproved_origin" };
    }
    try {
      const response = await fetchImpl(`${baseUrl}/validate-key`, {
        method: "GET",
        headers: { "X-API-Key": apiKey },
        // Never forward a user's credential through an upstream redirect.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) return rejected();
        return { outcome: "unverified", reason: "upstream_status", status: response.status };
      }
      const body: unknown = await response.json();
      const valid = body && typeof body === "object" && "valid" in body ? body.valid : undefined;
      if (valid === true) return { outcome: "valid" };
      if (valid === false) return rejected();
      return { outcome: "unverified", reason: "malformed_response" };
    } catch (error) {
      // Upstream bodies/errors may contain credentials; do not forward or log them.
      return { outcome: "unverified", reason: error instanceof SyntaxError ? "malformed_response" : "transport" };
    }
  };
}

function rejected(): MedevidenceRuntimeKeyResult {
  return {
    outcome: "rejected",
    error: new GatewayError({
      code: "account_migration_required",
      message: "The account credential is not ready on the selected MedEvidence service. Please contact support.",
      httpStatus: 409
    })
  };
}
