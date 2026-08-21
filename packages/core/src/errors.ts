import type { ProviderFailureClassification } from "./provider-failure.js";

export const gatewayErrorCodes = [
  "missing_credential",
  "invalid_credential",
  "revoked_credential",
  "expired_credential",
  "access_token_invalid",
  "access_token_expired",
  "refresh_token_invalid",
  "phone_not_registered",
  "phone_login_disabled",
  "account_disabled",
  "capability_not_allowed",
  "phone_identity_conflict",
  "account_migration_required",
  "client_upgrade_required",
  "auth_rate_limited",
  "invalid_request",
  "unsupported_parameter",
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
  "model_not_allowed_for_credential",
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
  "context_compaction_required",
  "output_length_exceeded",
  "client_aborted",
  "upstream_timeout",
  "upstream_unavailable",
  "upstream_incomplete_stream",
  "upstream_empty_response",
  "tool_call_output_truncated",
  "tool_call_validation_failed",
  // Public compatibility error code; do not rename during upstream account cleanup.
  "subscription_unavailable",
  "provider_reauth_required",
  "research_capability_required",
  "resource_access_denied",
  "run_not_found",
  "artifact_not_found",
  "run_not_complete",
  "identity_selection_not_expected",
  "invalid_run_transition",
  "run_expired",
  "artifact_expired",
  "vision_asset_not_found",
  "vision_asset_expired",
  "vision_asset_invalid",
  "research_worker_unavailable",
  "research_storage_unavailable",
  "research_backup_stale",
  "issue_job_not_found",
  "issue_already_running",
  "issue_validation_unreachable",
  "issue_validation_failed",
  "service_unavailable"
] as const;

export type GatewayErrorCode = (typeof gatewayErrorCodes)[number];

export type ToolCallValidationFailureKind =
  | "invalid_json"
  | "schema_mismatch"
  | "undeclared_tool"
  | "tool_choice_mismatch";

export type GatewayFailureKind =
  | ToolCallValidationFailureKind
  | "confirmed_output_limit"
  | "argument_budget_exceeded"
  | "upstream_incomplete";

export type GatewayRecoveryOwner = "client" | "gateway";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;
  readonly upstreamStatus?: number;
  readonly contractVersion?: number;
  readonly failureKind?: GatewayFailureKind;
  readonly transformedRetryAllowed?: boolean;
  readonly recommendedAction?: string;
  readonly recoveryOwner?: GatewayRecoveryOwner;
  readonly providerFailure?: ProviderFailureClassification;

  constructor(input: {
    code: GatewayErrorCode;
    message: string;
    httpStatus: number;
    retryAfterSeconds?: number;
    upstreamStatus?: number;
    contractVersion?: number;
    failureKind?: GatewayFailureKind;
    transformedRetryAllowed?: boolean;
    recommendedAction?: string;
    recoveryOwner?: GatewayRecoveryOwner;
    providerFailure?: ProviderFailureClassification;
  }) {
    super(input.message);
    this.name = "GatewayError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.upstreamStatus = input.upstreamStatus;
    this.contractVersion = input.contractVersion;
    this.failureKind = input.failureKind;
    this.transformedRetryAllowed = input.transformedRetryAllowed;
    this.recommendedAction = input.recommendedAction;
    this.recoveryOwner = input.recoveryOwner;
    this.providerFailure = input.providerFailure;
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
