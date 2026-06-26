export const subjectColumns =
  "id, label, name, phone_number, external_provider, external_user_id, display_name, state, created_at";

export const accessCredentialColumns =
  "id, prefix, hash, token_ciphertext, subject_id, label, scope, expires_at, revoked_at, rate_json, created_at, rotates_id";

export const unifiedClientKeyColumns =
  "id, prefix, hash, subject_id, label, expires_at, revoked_at, codex_credential_id, codex_credential_prefix, codex_key_ciphertext, medevidence_key_ciphertext, medevidence_key_prefix, created_at, metadata_json";

export const billingAdminTokenColumns =
  "id, prefix, hash, label, kind, state, expires_at, revoked_at, created_at, last_used_at, metadata_json";

export const planColumns =
  "id, display_name, policy_json, feature_policy_json, scope_allowlist_json, priority_class, team_pool_id, state, created_at, metadata_json";

export const entitlementColumns =
  "id, subject_id, plan_id, policy_snapshot_json, feature_policy_snapshot_json, scope_allowlist_json, period_kind, period_start, period_end, state, team_seat_id, created_at, cancelled_at, cancelled_reason, notes";

export const adminAuditEventColumns =
  "id, action, target_user_id, target_credential_id, target_credential_prefix, status, params_json, error_message, created_at";

export const sessionColumns =
  "id, subject_id, upstream_account_id, provider_session_ref, title, state, created_at, updated_at";

export const requestEventColumns =
  "request_id, credential_id, subject_id, scope, session_id, upstream_account_id, provider, public_model_id, upstream_runtime, upstream_model, started_at, duration_ms, first_byte_ms, status, error_code, rate_limited, prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens, estimated_tokens, usage_source, limit_kind, reservation_id, over_request_limit, identity_guard_hit";
