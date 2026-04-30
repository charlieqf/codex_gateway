export const subjectColumns = "id, label, name, phone_number, state, created_at";

export const accessCredentialColumns =
  "id, prefix, hash, token_ciphertext, subject_id, label, scope, expires_at, revoked_at, rate_json, created_at, rotates_id";

export const planColumns =
  "id, display_name, policy_json, scope_allowlist_json, priority_class, team_pool_id, state, created_at, metadata_json";

export const entitlementColumns =
  "id, subject_id, plan_id, policy_snapshot_json, scope_allowlist_json, period_kind, period_start, period_end, state, team_seat_id, created_at, cancelled_at, cancelled_reason, notes";

export const adminAuditEventColumns =
  "id, action, target_user_id, target_credential_id, target_credential_prefix, status, params_json, error_message, created_at";

export const sessionColumns =
  "id, subject_id, upstream_account_id, provider_session_ref, title, state, created_at, updated_at";

export const requestEventColumns =
  "request_id, credential_id, subject_id, scope, session_id, upstream_account_id, provider, started_at, duration_ms, first_byte_ms, status, error_code, rate_limited, prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens, estimated_tokens, usage_source, limit_kind, reservation_id, over_request_limit, identity_guard_hit";
