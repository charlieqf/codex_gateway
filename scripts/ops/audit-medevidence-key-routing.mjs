// Run inside the R760 Gateway container. No database writes or secret output.
// Default: metadata only. --probe validates existing keys at both approved origins.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { decryptSecret } from "@codex-gateway/core";

const origins = {
  cn: "https://gw-47-116-7-37.nip.io",
  r760: "https://r760.instmarket.com.au:1443"
};
const probe = process.argv.includes("--probe");
const now = new Date().toISOString();
const db = new DatabaseSync("/var/lib/codex-gateway/gateway.db", { readOnly: true });
db.exec("PRAGMA query_only=ON");
const rows = db.prepare(`
  SELECT u.id, u.subject_id, u.is_current, u.expires_at, u.metadata_json,
    u.medevidence_key_prefix, u.medevidence_key_ciphertext, u.codex_key_ciphertext,
    a.hash AS backing_hash, a.scope, u.credential_class,
    s.phone_number, s.label AS subject_label, s.name AS subject_name
  FROM unified_client_keys u
  JOIN subjects s ON s.id=u.subject_id
  JOIN access_credentials a ON a.id=u.codex_credential_id
    AND a.prefix=u.codex_credential_prefix AND a.subject_id=u.subject_id
  WHERE u.revoked_at IS NULL AND u.expires_at>?
    AND a.revoked_at IS NULL AND a.expires_at>? AND s.state='active'
  ORDER BY u.id
`).all(now, now);
db.close();
if (probe && !process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET) {
  throw new Error("Gateway encryption secret is unavailable; no probes performed.");
}

const validationCache = new Map();
async function validate(origin, key) {
  const cacheKey = `${origin}:${createHash("sha256").update(key).digest("hex")}`;
  if (!validationCache.has(cacheKey)) {
    validationCache.set(cacheKey, (async () => {
      try {
        const response = await fetch(`${origin}/validate-key`, {
          headers: { "X-API-Key": key },
          redirect: "error",
          signal: AbortSignal.timeout(5000)
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          return { state: "rejected", http_status: response.status };
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          return { state: "unavailable", http_status: response.status };
        }
        const body = await response.json();
        return { state: body?.valid === true ? "valid" : "unconfirmed", http_status: 200 };
      } catch {
        return { state: "unavailable", http_status: null };
      }
    })());
  }
  return validationCache.get(cacheKey);
}

let cursor = 0;
const records = new Array(rows.length);
async function worker() {
  while (cursor < rows.length) {
    const index = cursor++;
    const row = rows[index];
    let metadata;
    try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { metadata = {}; }
    const stored = metadata?.medevidence_base_url ?? null;
    const origin = Object.entries(origins).find(([, value]) => value === stored)?.[0]
      ?? (stored === null ? "missing" : "unmanaged");
    const result = {
      unified_key_id: row.id, subject_id: row.subject_id,
      current: Boolean(row.is_current), expires_at: row.expires_at,
      scope: row.scope, credential_class: row.credential_class,
      has_phone: Boolean(row.phone_number?.trim()),
      test_marker: /smoke|e2e|test|canary|fixture|\u6d4b\u8bd5|\u9a8c\u6536|\u4e34\u65f6/i
        .test([row.subject_label, row.subject_name].join(" ")),
      stored_origin: origin, gateway_managed: origin !== "unmanaged" &&
        (origin !== "missing" || Boolean(row.medevidence_key_prefix))
    };
    records[index] = result;
    if (!probe || !result.gateway_managed) continue;
    try {
      const secret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
      const backing = decryptSecret(row.codex_key_ciphertext, secret);
      const backingHash = `sha256:${createHash("sha256").update(backing).digest("base64url")}`;
      if (backingHash !== row.backing_hash) {
        result.bundle_state = "invalid_backing_token";
        continue;
      }
      const key = decryptSecret(row.medevidence_key_ciphertext, secret);
      result.bundle_state = "decryptable_backing_verified";
      result.r760 = await validate(origins.r760, key);
      result.cn = await validate(origins.cn, key);
    } catch {
      result.bundle_state = "decryption_failed";
    }
  }
}
await Promise.all([worker(), worker()]);
const groups = {};
for (const record of records) {
  const group = [record.current ? "current" : "historical", record.stored_origin,
    record.bundle_state ?? "not_probed", record.r760?.state ?? "not_probed",
    record.cn?.state ?? "not_probed"].join("|");
  groups[group] = (groups[group] ?? 0) + 1;
}
console.log(JSON.stringify({
  started_at: now, completed_at: new Date().toISOString(), read_only: true, probed: probe,
  eligible_records: records.length, subjects: new Set(records.map(r => r.subject_id)).size,
  unique_origin_key_probes: validationCache.size, groups, records
}, null, 2));
