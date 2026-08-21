import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  classifyProviderHttpFailure,
  isProviderFailureClassification,
  resolveUpstreamAttemptPurpose,
  summarizeUpstreamAttemptPurposes,
  unknownProviderFailure
} from "./provider-failure.js";

describe("provider failure classification", () => {
  it.each([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ECONNREFUSED", "connect"],
    ["ECONNRESET", "connection_reset"],
    ["EPIPE", "connection_reset"],
    ["UND_ERR_SOCKET", "connection_reset"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ["UND_ERR_PROXY", "proxy_connect"]
  ] as const)("classifies nested transport code %s", (code, kind) => {
    const cause = Object.assign(new Error("private transport detail"), { code });
    const error = new TypeError("fetch failed", { cause });

    expect(classifyProviderFailure({ error, stage: "before_headers" })).toEqual({
      origin: kind === "proxy_connect" ? "proxy" : "network",
      kind,
      stage: "before_headers",
      transportCode: code,
      upstreamStatus: null
    });
  });

  it.each([
    [400, "http_request"],
    [401, "http_auth"],
    [403, "http_auth"],
    [408, "http_timeout"],
    [429, "http_rate_limit"],
    [500, "http_server"],
    [503, "http_server"],
    [504, "http_timeout"]
  ] as const)("classifies HTTP %i", (status, kind) => {
    expect(classifyProviderHttpFailure(status)).toEqual({
      origin: "provider",
      kind,
      stage: "after_headers",
      transportCode: null,
      upstreamStatus: status
    });
  });

  it("distinguishes client abort and Gateway deadline", () => {
    expect(
      classifyProviderFailure({
        error: new DOMException("aborted", "AbortError"),
        abortSource: "client",
        stage: "streaming"
      })
    ).toMatchObject({ origin: "client", kind: "client_aborted", stage: "streaming" });
    expect(
      classifyProviderFailure({
        error: new DOMException("aborted", "AbortError"),
        abortSource: "gateway",
        stage: "before_headers"
      })
    ).toMatchObject({ origin: "gateway", kind: "deadline_exceeded" });
  });

  it.each([401, 403])(
    "preserves an explicit provider reauth classification for HTTP %i",
    (upstreamStatus) => {
      expect(
        classifyProviderFailure({
          upstreamStatus,
          originHint: "provider",
          kindHint: "provider_reauth",
          stage: "before_headers"
        })
      ).toEqual({
        origin: "provider",
        kind: "provider_reauth",
        stage: "before_headers",
        transportCode: null,
        upstreamStatus
      });
    }
  );

  it("uses explicit response and stream failure hints without reading raw messages", () => {
    expect(
      classifyProviderFailure({
        kindHint: "response_body_missing",
        originHint: "provider",
        stage: "after_headers",
        upstreamStatus: 200
      })
    ).toEqual({
      origin: "provider",
      kind: "response_body_missing",
      stage: "after_headers",
      transportCode: null,
      upstreamStatus: 200
    });
    expect(
      classifyProviderFailure({
        kindHint: "stream_protocol",
        originHint: "provider",
        stage: "streaming"
      })
    ).toMatchObject({ origin: "provider", kind: "stream_protocol", stage: "streaming" });
    expect(
      classifyProviderFailure({
        kindHint: "stream_incomplete",
        originHint: "provider",
        stage: "streaming"
      })
    ).toMatchObject({ origin: "provider", kind: "stream_incomplete", stage: "streaming" });
  });

  it("walks AggregateError causes and prefers the nearest known transport code", () => {
    const unknown = Object.assign(new Error("unknown"), { code: "VENDOR_PRIVATE_CODE" });
    const known = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
    const error = new AggregateError([unknown, known], "fetch failed");

    expect(classifyProviderFailure({ error, stage: "before_headers" })).toMatchObject({
      origin: "network",
      kind: "dns",
      transportCode: "ENOTFOUND"
    });
  });

  it("bounds cause walking, handles cycles, and rejects unsafe transport codes", () => {
    const cyclic = Object.assign(new Error("cycle"), { code: "host.example.invalid/path" });
    Object.assign(cyclic, { cause: cyclic });
    expect(classifyProviderFailure({ error: cyclic })).toEqual(unknownProviderFailure());

    let deep: Error = Object.assign(new Error("deep"), { code: "ENOTFOUND" });
    for (let index = 0; index < 6; index += 1) {
      deep = new Error(`layer-${index}`, { cause: deep });
    }
    expect(classifyProviderFailure({ error: deep })).toEqual(unknownProviderFailure());

    const tooLong = Object.assign(new Error("long"), { code: "A".repeat(65) });
    expect(classifyProviderFailure({ error: tooLong })).toEqual(unknownProviderFailure());
  });

  it("classifies bare fetch failed as a network unknown and unrelated errors as unknown", () => {
    expect(
      classifyProviderFailure({ error: new TypeError("fetch failed"), stage: "before_headers" })
    ).toEqual({
      origin: "network",
      kind: "unknown",
      stage: "before_headers",
      transportCode: null,
      upstreamStatus: null
    });
    expect(classifyProviderFailure({ error: new Error("unrelated") })).toEqual(
      unknownProviderFailure()
    );
  });

  it("validates only safe persisted classification shapes", () => {
    expect(isProviderFailureClassification(unknownProviderFailure())).toBe(true);
    expect(
      isProviderFailureClassification({
        ...unknownProviderFailure(),
        transportCode: "Authorization=Bearer-secret"
      })
    ).toBe(false);
  });
});

describe("upstream attempt purposes", () => {
  it.each([
    ["primary", "primary"],
    ["native", "primary"],
    ["native_initial", "primary"],
    ["strict_initial", "primary"],
    ["stateless_retry", "failure_retry"],
    ["auto_ack_to_required", "contract_recovery"],
    ["auto_ack_to_auto", "contract_recovery"],
    ["auto_ack_after_tool_to_auto", "contract_recovery"],
    ["auto_empty_to_auto", "contract_recovery"],
    ["validation_failed_to_same", "contract_recovery"],
    ["validation_failed_to_auto", "contract_recovery"],
    ["strict_repair", "contract_recovery"]
  ] as const)("maps legacy kind %s to %s", (kind, purpose) => {
    expect(resolveUpstreamAttemptPurpose({ kind }, 1)).toBe(purpose);
  });

  it("uses a missing first kind as primary and later unknown kinds as unknown", () => {
    expect(resolveUpstreamAttemptPurpose({}, 1)).toBe("primary");
    expect(resolveUpstreamAttemptPurpose({ kind: "future_kind" }, 2)).toBe("unknown");
  });

  it("separates failure retries, contract recovery, and unclassified attempts", () => {
    expect(
      summarizeUpstreamAttemptPurposes([
        { index: 1, kind: "primary", purpose: "primary" },
        { index: 2, kind: "stateless_retry", purpose: "failure_retry" },
        { index: 3, kind: "validation_failed_to_same", purpose: "contract_recovery" },
        { index: 4, kind: "future_kind", purpose: "unknown" }
      ])
    ).toEqual({
      failureRetryCount: 1,
      recoveryAttemptCount: 1,
      unclassifiedAdditionalAttemptCount: 1,
      attemptPurposeMissing: 1,
      primaryOverflowCount: 0,
      purposes: ["primary", "failure_retry", "contract_recovery", "unknown"]
    });
  });

  it("flags a second primary as unclassified instead of calling it a retry", () => {
    expect(
      summarizeUpstreamAttemptPurposes([
        { index: 1, purpose: "primary" },
        { index: 2, purpose: "primary" }
      ])
    ).toMatchObject({
      failureRetryCount: 0,
      recoveryAttemptCount: 0,
      unclassifiedAdditionalAttemptCount: 1,
      primaryOverflowCount: 1
    });
  });
});
