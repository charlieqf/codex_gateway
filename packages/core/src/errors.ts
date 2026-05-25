export const gatewayErrorCodes = [
  "missing_credential",
  "invalid_credential",
  "revoked_credential",
  "expired_credential",
  "invalid_request",
  "invalid_event_type",
  "invalid_period",
  "invalid_external_user_id",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
  "subject_not_found",
  "subject_already_exists",
  "plan_not_found",
  "entitlement_not_found",
  "credential_not_found",
  "entitlement_already_active",
  "invalid_entitlement_transition",
  "model_not_found",
  "rate_limited",
  "forbidden_scope",
  "plan_inactive",
  "plan_expired",
  "plan_capability_required",
  "session_not_found",
  "unsupported_model",
  "unsupported_size",
  "unsupported_quality",
  "unsupported_format",
  "content_policy_violation",
  "context_length_exceeded",
  "client_aborted",
  "upstream_timeout",
  "upstream_unavailable",
  "tool_call_validation_failed",
  // Public compatibility error code; do not rename during upstream account cleanup.
  "subscription_unavailable",
  "provider_reauth_required",
  "service_unavailable"
] as const;

export type GatewayErrorCode = (typeof gatewayErrorCodes)[number];

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;
  readonly upstreamStatus?: number;

  constructor(input: {
    code: GatewayErrorCode;
    message: string;
    httpStatus: number;
    retryAfterSeconds?: number;
    upstreamStatus?: number;
  }) {
    super(input.message);
    this.name = "GatewayError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.upstreamStatus = input.upstreamStatus;
  }
}

export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) {
    return err;
  }

  return new GatewayError({
    code: "service_unavailable",
    message: "Service temporarily unavailable.",
    httpStatus: 503
  });
}
