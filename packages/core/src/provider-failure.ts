export const providerFailureOrigins = [
  "client",
  "gateway",
  "network",
  "proxy",
  "provider",
  "unknown"
] as const;

export type ProviderFailureOrigin = (typeof providerFailureOrigins)[number];

export const providerFailureKinds = [
  "client_aborted",
  "deadline_exceeded",
  "dns",
  "connect",
  "connection_reset",
  "tls",
  "proxy_connect",
  "http_auth",
  "http_rate_limit",
  "http_request",
  "http_timeout",
  "http_server",
  "response_body_missing",
  "stream_incomplete",
  "stream_protocol",
  "provider_reauth",
  "unknown"
] as const;

export type ProviderFailureKind = (typeof providerFailureKinds)[number];

export const providerFailureStages = [
  "before_headers",
  "after_headers",
  "streaming",
  "unknown"
] as const;

export type ProviderFailureStage = (typeof providerFailureStages)[number];

export interface ProviderFailureClassification {
  origin: ProviderFailureOrigin;
  kind: ProviderFailureKind;
  stage: ProviderFailureStage;
  transportCode: string | null;
  upstreamStatus: number | null;
}

export const upstreamAttemptPurposes = [
  "primary",
  "failure_retry",
  "contract_recovery",
  "unknown"
] as const;

export type UpstreamAttemptPurpose = (typeof upstreamAttemptPurposes)[number];

export interface ClassifyProviderFailureInput {
  error?: unknown;
  stage?: ProviderFailureStage;
  upstreamStatus?: number | null;
  abortSource?: "client" | "gateway" | null;
  originHint?: ProviderFailureOrigin;
  kindHint?: ProviderFailureKind;
}

export interface UpstreamAttemptPurposeInput {
  index?: number | null;
  kind?: string | null;
  purpose?: UpstreamAttemptPurpose | null;
}

export interface UpstreamAttemptPurposeSummary {
  failureRetryCount: number;
  recoveryAttemptCount: number;
  unclassifiedAdditionalAttemptCount: number;
  attemptPurposeMissing: number;
  primaryOverflowCount: number;
  purposes: UpstreamAttemptPurpose[];
}

const transportCodePattern = /^[A-Z0-9_-]{1,64}$/u;
const dnsCodes = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const connectCodes = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT",
  "UND_ERR_CONNECT_TIMEOUT"
]);
const connectionResetCodes = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET"
]);
const proxyConnectCodes = new Set([
  "ERR_HTTP_PROXY_CONNECT",
  "ERR_PROXY_CONNECTION_FAILED",
  "PROXY_CONNECT_FAILED",
  "UND_ERR_PROXY"
]);
const tlsCodes = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

const attemptPurposeByKind: Readonly<Record<string, UpstreamAttemptPurpose>> = {
  primary: "primary",
  native: "primary",
  native_initial: "primary",
  strict_initial: "primary",
  stateless_retry: "failure_retry",
  auto_ack_to_required: "contract_recovery",
  auto_ack_to_auto: "contract_recovery",
  auto_ack_after_tool_to_auto: "contract_recovery",
  auto_empty_to_auto: "contract_recovery",
  validation_failed_to_same: "contract_recovery",
  validation_failed_to_auto: "contract_recovery",
  strict_repair: "contract_recovery"
};

export function classifyProviderFailure(
  input: ClassifyProviderFailureInput
): ProviderFailureClassification {
  const stage = input.stage ?? "unknown";
  const facts = inspectErrorChain(input.error);
  const upstreamStatus = validHttpStatus(input.upstreamStatus) ?? facts.status;
  const transportCode = facts.transportCode;

  if (input.abortSource === "client") {
    return classification("client", "client_aborted", stage, transportCode, upstreamStatus);
  }
  if (input.abortSource === "gateway") {
    return classification("gateway", "deadline_exceeded", stage, transportCode, upstreamStatus);
  }

  // A Codex authentication cache failure may carry an HTTP 401/403 status, but it is
  // operationally distinct from a provider API-key rejection. Preserve that explicit
  // adapter fact before applying the generic HTTP status taxonomy.
  if (input.kindHint === "provider_reauth") {
    return classification(
      input.originHint ?? "provider",
      "provider_reauth",
      stage,
      transportCode,
      upstreamStatus
    );
  }

  if (upstreamStatus !== null && upstreamStatus >= 400) {
    return classifyHttpStatus(upstreamStatus, stage, transportCode);
  }

  if (input.kindHint && input.kindHint !== "unknown") {
    return classification(
      input.originHint ?? originForKind(input.kindHint),
      input.kindHint,
      stage,
      transportCode,
      upstreamStatus
    );
  }

  const transportFailure = classifyTransportCode(transportCode, stage, upstreamStatus);
  if (transportFailure) {
    return transportFailure;
  }

  if (facts.names.includes("AbortError") || facts.names.includes("TimeoutError")) {
    return classification("gateway", "deadline_exceeded", stage, transportCode, upstreamStatus);
  }

  if (isStrictFetchFailed(input.error)) {
    return classification("network", "unknown", stage, transportCode, upstreamStatus);
  }

  return classification(
    input.originHint ?? "unknown",
    input.kindHint ?? "unknown",
    stage,
    transportCode,
    upstreamStatus
  );
}

export function classifyProviderHttpFailure(
  upstreamStatus: number,
  stage: ProviderFailureStage = "after_headers"
): ProviderFailureClassification {
  return classifyProviderFailure({ upstreamStatus, stage });
}

export function unknownProviderFailure(
  stage: ProviderFailureStage = "unknown"
): ProviderFailureClassification {
  return classification("unknown", "unknown", stage, null, null);
}

export function isProviderFailureClassification(
  value: unknown
): value is ProviderFailureClassification {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isOneOf(value.origin, providerFailureOrigins) &&
    isOneOf(value.kind, providerFailureKinds) &&
    isOneOf(value.stage, providerFailureStages) &&
    (value.transportCode === null ||
      (typeof value.transportCode === "string" &&
        transportCodePattern.test(value.transportCode))) &&
    (value.upstreamStatus === null || validHttpStatus(value.upstreamStatus) !== null)
  );
}

export function resolveUpstreamAttemptPurpose(
  attempt: UpstreamAttemptPurposeInput,
  fallbackIndex: number
): UpstreamAttemptPurpose {
  if (attempt.purpose && isOneOf(attempt.purpose, upstreamAttemptPurposes)) {
    return attempt.purpose;
  }
  if (attempt.kind && attemptPurposeByKind[attempt.kind]) {
    return attemptPurposeByKind[attempt.kind];
  }
  const index = validAttemptIndex(attempt.index) ?? fallbackIndex;
  return index === 1 && !attempt.kind ? "primary" : "unknown";
}

export function summarizeUpstreamAttemptPurposes(
  attempts: readonly UpstreamAttemptPurposeInput[]
): UpstreamAttemptPurposeSummary {
  let failureRetryCount = 0;
  let recoveryAttemptCount = 0;
  let unclassifiedAdditionalAttemptCount = 0;
  let attemptPurposeMissing = 0;
  let primaryCount = 0;
  const purposes: UpstreamAttemptPurpose[] = [];

  for (const [position, attempt] of attempts.entries()) {
    const fallbackIndex = position + 1;
    const index = validAttemptIndex(attempt.index) ?? fallbackIndex;
    const purpose = resolveUpstreamAttemptPurpose(attempt, fallbackIndex);
    purposes.push(purpose);
    if (purpose === "failure_retry") {
      failureRetryCount += 1;
    } else if (purpose === "contract_recovery") {
      recoveryAttemptCount += 1;
    } else if (purpose === "primary") {
      primaryCount += 1;
      if (primaryCount > 1) {
        unclassifiedAdditionalAttemptCount += 1;
      }
    } else {
      attemptPurposeMissing += 1;
      if (index > 1) {
        unclassifiedAdditionalAttemptCount += 1;
      }
    }
  }

  return {
    failureRetryCount,
    recoveryAttemptCount,
    unclassifiedAdditionalAttemptCount,
    attemptPurposeMissing,
    primaryOverflowCount: Math.max(primaryCount - 1, 0),
    purposes
  };
}

function classifyHttpStatus(
  status: number,
  stage: ProviderFailureStage,
  transportCode: string | null
): ProviderFailureClassification {
  if (status === 401 || status === 403) {
    return classification("provider", "http_auth", stage, transportCode, status);
  }
  if (status === 429) {
    return classification("provider", "http_rate_limit", stage, transportCode, status);
  }
  if (status === 408 || status === 504) {
    return classification("provider", "http_timeout", stage, transportCode, status);
  }
  if (status >= 400 && status <= 499) {
    return classification("provider", "http_request", stage, transportCode, status);
  }
  if (status >= 500 && status <= 599) {
    return classification("provider", "http_server", stage, transportCode, status);
  }
  return classification("provider", "unknown", stage, transportCode, status);
}

function classifyTransportCode(
  code: string | null,
  stage: ProviderFailureStage,
  upstreamStatus: number | null
): ProviderFailureClassification | null {
  if (!code) {
    return null;
  }
  if (proxyConnectCodes.has(code) || code.includes("PROXY_CONNECT")) {
    return classification("proxy", "proxy_connect", stage, code, upstreamStatus);
  }
  if (dnsCodes.has(code)) {
    return classification("network", "dns", stage, code, upstreamStatus);
  }
  if (connectCodes.has(code)) {
    return classification("network", "connect", stage, code, upstreamStatus);
  }
  if (connectionResetCodes.has(code)) {
    return classification("network", "connection_reset", stage, code, upstreamStatus);
  }
  if (
    tlsCodes.has(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_")
  ) {
    return classification("network", "tls", stage, code, upstreamStatus);
  }
  return null;
}

function inspectErrorChain(error: unknown): {
  transportCode: string | null;
  status: number | null;
  names: string[];
} {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  const codes: string[] = [];
  const names: string[] = [];
  let status: number | null = null;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= 6 || !isRecord(current.value)) {
      continue;
    }
    if (seen.has(current.value)) {
      continue;
    }
    seen.add(current.value);

    if (typeof current.value.name === "string") {
      names.push(current.value.name);
    }
    const code = transportCode(current.value.code);
    if (code) {
      codes.push(code);
    }
    status ??= validFailureHttpStatus(current.value.status);
    status ??= validFailureHttpStatus(current.value.statusCode);

    if ("cause" in current.value) {
      queue.push({ value: current.value.cause, depth: current.depth + 1 });
    }
    if (Array.isArray(current.value.errors)) {
      for (const nested of current.value.errors) {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }

  return {
    transportCode: codes.find((code) => classifyTransportCode(code, "unknown", null)) ?? codes[0] ?? null,
    status,
    names
  };
}

function originForKind(kind: ProviderFailureKind): ProviderFailureOrigin {
  if (kind === "client_aborted") return "client";
  if (kind === "deadline_exceeded") return "gateway";
  if (["dns", "connect", "connection_reset", "tls"].includes(kind)) return "network";
  if (kind === "proxy_connect") return "proxy";
  if (kind === "unknown") return "unknown";
  return "provider";
}

function classification(
  origin: ProviderFailureOrigin,
  kind: ProviderFailureKind,
  stage: ProviderFailureStage,
  transportCode: string | null,
  upstreamStatus: number | null
): ProviderFailureClassification {
  return { origin, kind, stage, transportCode, upstreamStatus };
}

function validHttpStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function validFailureHttpStatus(value: unknown): number | null {
  const status = validHttpStatus(value);
  return status !== null && status >= 400 ? status : null;
}

function transportCode(value: unknown): string | null {
  return typeof value === "string" && transportCodePattern.test(value) ? value : null;
}

function validAttemptIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isStrictFetchFailed(value: unknown): boolean {
  return value instanceof Error && value.name === "TypeError" && value.message === "fetch failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
