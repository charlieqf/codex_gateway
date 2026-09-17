import { DatabaseSync } from "node:sqlite";

const path = process.env.GATEWAY_SQLITE_PATH ?? "/var/lib/codex-gateway/gateway.db";
const db = new DatabaseSync(path, { readOnly: true });
db.exec("PRAGMA query_only=ON; BEGIN");

try {
  const now = new Date().toISOString();
  const integrity = {
    quick_check: db.prepare("PRAGMA quick_check").get()?.quick_check ?? null,
    foreign_key_violations: db.prepare("PRAGMA foreign_key_check").all().length
  };
  const identities = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN p.state = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN p.state = 'disabled' THEN 1 ELSE 0 END) AS disabled,
         SUM(CASE WHEN s.id IS NULL OR s.state <> 'active' THEN 1 ELSE 0 END)
           AS subject_not_active,
         SUM(CASE WHEN p.state = 'active' AND
                            (s.id IS NULL OR s.state <> 'active')
                  THEN 1 ELSE 0 END) AS active_identity_subject_not_active,
         SUM(CASE WHEN u.id IS NULL OR u.subject_id <> p.subject_id OR
                            u.is_current <> 1 OR u.credential_class <> 'desktop' OR
                            u.revoked_at IS NOT NULL OR u.expires_at <= ? OR
                            u.token_ciphertext IS NULL OR u.token_ciphertext = ''
                  THEN 1 ELSE 0 END) AS unified_key_unhealthy,
         SUM(CASE WHEN p.state = 'active' AND
                            (u.id IS NULL OR u.subject_id <> p.subject_id OR
                             u.is_current <> 1 OR u.credential_class <> 'desktop' OR
                             u.revoked_at IS NOT NULL OR u.expires_at <= ? OR
                             u.token_ciphertext IS NULL OR u.token_ciphertext = '')
                  THEN 1 ELSE 0 END) AS active_identity_unified_key_unhealthy,
         SUM(CASE WHEN c.id IS NULL OR c.id <> u.codex_credential_id OR
                            c.subject_id <> p.subject_id OR
                            c.credential_class <> 'desktop' OR
                            c.revoked_at IS NOT NULL OR c.expires_at <= ? OR
                            (c.allowed_public_models_json IS NOT NULL AND
                             c.allowed_public_models_json NOT LIKE '%"goldencode"%')
                  THEN 1 ELSE 0 END) AS backing_credential_unhealthy,
         SUM(CASE WHEN p.state = 'active' AND
                            (c.id IS NULL OR c.id <> u.codex_credential_id OR
                             c.subject_id <> p.subject_id OR
                             c.credential_class <> 'desktop' OR
                             c.revoked_at IS NOT NULL OR c.expires_at <= ? OR
                             (c.allowed_public_models_json IS NOT NULL AND
                              c.allowed_public_models_json NOT LIKE '%"goldencode"%'))
                  THEN 1 ELSE 0 END) AS active_identity_backing_credential_unhealthy,
         SUM(CASE WHEN NOT EXISTS (
                    SELECT 1 FROM entitlements e
                    WHERE e.subject_id = p.subject_id
                      AND e.state = 'active'
                      AND e.period_start <= ?
                      AND (e.period_end IS NULL OR e.period_end > ?)
                      AND e.scope_allowlist_json LIKE '%"code"%'
                      AND e.feature_policy_snapshot_json LIKE '%"chat"%'
                  ) THEN 1 ELSE 0 END) AS active_chat_entitlement_missing,
         SUM(CASE WHEN p.state = 'active' AND NOT EXISTS (
                    SELECT 1 FROM entitlements e
                    WHERE e.subject_id = p.subject_id
                      AND e.state = 'active'
                      AND e.period_start <= ?
                      AND (e.period_end IS NULL OR e.period_end > ?)
                      AND e.scope_allowlist_json LIKE '%"code"%'
                      AND e.feature_policy_snapshot_json LIKE '%"chat"%'
                  ) THEN 1 ELSE 0 END) AS active_identity_chat_entitlement_missing,
         SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM entitlements e
                    WHERE e.subject_id = p.subject_id
                      AND e.state = 'paused'
                      AND e.period_start <= ?
                      AND (e.period_end IS NULL OR e.period_end > ?)
                      AND e.scope_allowlist_json LIKE '%"code"%'
                      AND e.feature_policy_snapshot_json LIKE '%"chat"%'
                  ) THEN 1 ELSE 0 END) AS resumable_paused_chat_entitlement
       FROM phone_auth_identities p
       LEFT JOIN subjects s ON s.id = p.subject_id
       LEFT JOIN unified_client_keys u ON u.id = p.unified_key_id
       LEFT JOIN access_credentials c ON c.id = u.codex_credential_id`
    )
    .get(now, now, now, now, now, now, now, now, now, now);
  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active
       FROM phone_auth_sessions`
    )
    .get();

  console.log(
    JSON.stringify({
      inspected_at_utc: now,
      integrity,
      phone_identities: identities,
      phone_sessions: sessions,
      contains_personal_data: false
    })
  );
} finally {
  db.exec("ROLLBACK");
  db.close();
}
