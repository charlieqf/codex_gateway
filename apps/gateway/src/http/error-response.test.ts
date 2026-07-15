import { describe, expect, it } from "vitest";
import { GatewayError, type LimitKind } from "@codex-gateway/core";
import { gatewayErrorMetadata } from "./error-response.js";

const gatewayLimitKinds: LimitKind[] = [
  "request_minute",
  "request_day",
  "concurrency",
  "token_request_prompt",
  "token_request_total",
  "token_minute",
  "token_day",
  "token_month"
];

describe("gatewayErrorMetadata", () => {
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
  if (limitKind === "request_minute" || limitKind === "token_minute") {
    return "minute" as const;
  }
  if (limitKind === "request_day" || limitKind === "token_day") {
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
  return "credential" as const;
}
