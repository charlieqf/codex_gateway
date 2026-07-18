import { describe, expect, it } from "vitest";
import {
  GatewayError,
  gatewayErrorCodes,
  type LimitKind
} from "@codex-gateway/core";
import { researchRouteConfig } from "./context.js";
import {
  gatewayErrorMetadata,
  researchErrorPayload
} from "./error-response.js";

const gatewayLimitKinds: LimitKind[] = [
  "request_minute",
  "request_day",
  "concurrency",
  "token_request_prompt",
  "token_request_total",
  "token_minute",
  "token_day",
  "token_month",
  "research_control_read_minute",
  "research_control_mutation_minute",
  "research_active_brief",
  "research_needs_input",
  "research_daily_runs",
  "research_unique_doctors_30d",
  "research_global_queue"
];

describe("gatewayErrorMetadata", () => {
  it("exports the frozen additive Research error codes", () => {
    expect(gatewayErrorCodes).toEqual(
      expect.arrayContaining([
        "model_not_allowed_for_credential",
        "research_capability_required",
        "resource_access_denied",
        "run_not_found",
        "artifact_not_found",
        "run_not_complete",
        "identity_selection_not_expected",
        "invalid_run_transition",
        "run_expired",
        "artifact_expired",
        "research_worker_unavailable",
        "research_storage_unavailable",
        "research_backup_stale"
      ])
    );
  });

  it.each(gatewayLimitKinds)("publishes gateway limit metadata for %s", (limitKind) => {
    const metadata = gatewayErrorMetadata(rateLimitedError(), {
      requestId: "req_limit_contract",
      limitKind,
      rateLimitOrigin: "gateway",
      limitDetails: {
        scope: scopeFor(limitKind),
        window: windowFor(limitKind),
        limit: 100,
        used: 100,
        requested: 1
      }
    });

    expect(metadata).toEqual({
      request_id: "req_limit_contract",
      retry_after_seconds: 30,
      rate_limit_contract_version: 1,
      limit_kind: limitKind,
      rate_limit_origin: "gateway",
      limit: {
        scope: scopeFor(limitKind),
        window: windowFor(limitKind),
        maximum: 100,
        used: 100,
        requested: 1
      }
    });
  });

  it("publishes upstream rate limiting without a gateway limit kind", () => {
    expect(
      gatewayErrorMetadata(rateLimitedError(), {
        requestId: "req_upstream_limit",
        rateLimitOrigin: "upstream"
      })
    ).toEqual({
      request_id: "req_upstream_limit",
      retry_after_seconds: 30,
      rate_limit_contract_version: 1,
      limit_kind: null,
      rate_limit_origin: "upstream"
    });
  });

  it("publishes the frozen Research error envelope and route config", () => {
    expect(researchRouteConfig).toEqual({
      responseDialect: "research",
      skipRateLimit: true
    });
    expect(
      researchErrorPayload(rateLimitedError(), {
        requestId: "req_research_limit",
        researchCode: "research_quota_exceeded",
        limitKind: "research_active_brief",
        rateLimitOrigin: "gateway"
      })
    ).toEqual({
      schema_version: "doctor_research_error.v1",
      request_id: "req_research_limit",
      error: {
        code: "rate_limited",
        research_code: "research_quota_exceeded",
        message: "Rate limited.",
        retry_after_seconds: 30,
        rate_limit_contract_version: 1,
        limit_kind: "research_active_brief",
        rate_limit_origin: "gateway"
      }
    });
    expect(
      researchErrorPayload(
        new GatewayError({
          code: "run_not_found",
          message: "Research run was not found.",
          httpStatus: 404
        }),
        { requestId: "req_research_missing" }
      )
    ).toEqual({
      schema_version: "doctor_research_error.v1",
      request_id: "req_research_missing",
      error: {
        code: "run_not_found",
        message: "Research run was not found."
      }
    });
    expect(
      researchErrorPayload(
        new GatewayError({
          code: "research_worker_unavailable",
          message: "Research Worker is temporarily unavailable.",
          httpStatus: 503,
          retryAfterSeconds: 45
        }),
        { requestId: "req_research_retry" }
      )
    ).toEqual({
      schema_version: "doctor_research_error.v1",
      request_id: "req_research_retry",
      error: {
        code: "research_worker_unavailable",
        message: "Research Worker is temporarily unavailable.",
        retry_after_seconds: 45
      }
    });
  });
});

function rateLimitedError(): GatewayError {
  return new GatewayError({
    code: "rate_limited",
    message: "Rate limited.",
    httpStatus: 429,
    retryAfterSeconds: 30
  });
}

function windowFor(limitKind: LimitKind) {
  if (
    limitKind === "request_minute" ||
    limitKind === "token_minute" ||
    limitKind === "research_control_read_minute" ||
    limitKind === "research_control_mutation_minute"
  ) {
    return "minute" as const;
  }
  if (
    limitKind === "request_day" ||
    limitKind === "token_day" ||
    limitKind === "research_daily_runs"
  ) {
    return "day" as const;
  }
  if (limitKind === "token_month") {
    return "month" as const;
  }
  if (limitKind === "concurrency") {
    return "concurrency" as const;
  }
  return "request" as const;
}

function scopeFor(limitKind: LimitKind) {
  if (limitKind === "token_request_prompt" || limitKind === "token_request_total") {
    return "request" as const;
  }
  if (limitKind.startsWith("token_")) {
    return "entitlement" as const;
  }
  if (
    limitKind === "research_active_brief" ||
    limitKind === "research_needs_input" ||
    limitKind === "research_daily_runs" ||
    limitKind === "research_unique_doctors_30d"
  ) {
    return "subject" as const;
  }
  return "credential" as const;
}
