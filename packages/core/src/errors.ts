export const gatewayErrorCodes = [
  "missing_credential",
  "invalid_credential",
  "revoked_credential",
  "expired_credential",
  "invalid_request",
  "idempotency_conflict",
  "model_not_found",
  "rate_limited",
  "forbidden_scope",
  "session_not_found",
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

  constructor(input: {
    code: GatewayErrorCode;
    message: string;
    httpStatus: number;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = "GatewayError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.retryAfterSeconds = input.retryAfterSeconds;
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
