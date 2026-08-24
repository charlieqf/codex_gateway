#!/bin/sh
set -eu

gateway_container=codex_gateway_r760-gateway-1
mode=audit

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [--apply]" >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  if [ "$1" != "--apply" ]; then
    echo "usage: $0 [--apply]" >&2
    exit 2
  fi
  mode=apply
fi

tmp=$(mktemp -d /data/llm-runtime/qwen-api/access-migration.XXXXXX)
chmod 0700 "$tmp"
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  case "$tmp" in
    /data/llm-runtime/qwen-api/access-migration.*) rm -rf -- "$tmp" ;;
    *) echo "Refusing to remove unexpected temporary path: $tmp" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

admin() {
  docker exec "$gateway_container" node \
    /app/apps/admin-cli/dist/index.js \
    --db /var/lib/codex-gateway/gateway.db \
    "$@"
}

snapshot() {
  admin list-active-keys > "$tmp/credentials.json"
  admin list > "$tmp/credentials-all.json"
  admin unified-key list --active-only > "$tmp/unified.json"
  chmod 0600 "$tmp/credentials.json" "$tmp/credentials-all.json" "$tmp/unified.json"
}

print_summary() {
  active_total=$(jq '.credentials | length' "$tmp/credentials.json")
  unrestricted=$(jq '[.credentials[] | select(has("allowed_public_models") | not)] | length' "$tmp/credentials.json")
  eligible=$(jq '[.credentials[] | select((.allowed_public_models? // [] | index("goldencode")) != null and (.allowed_public_models | index("goldencode-local")) == null)] | length' "$tmp/credentials.json")
  dual=$(jq '[.credentials[] | select((.allowed_public_models? // [] | index("goldencode")) != null and (.allowed_public_models | index("goldencode-local")) != null)] | length' "$tmp/credentials.json")
  other_restricted=$(jq '[.credentials[] | select(has("allowed_public_models") and (.allowed_public_models | index("goldencode")) == null)] | length' "$tmp/credentials.json")
  active_unified=$(jq '.keys | length' "$tmp/unified.json")
  active_unified_backings=$(jq '[.keys[].codex_gateway.key_prefix] | unique | length' "$tmp/unified.json")
  eligible_by_class=$(jq -c '
    [
      .credentials[]
      | select((.allowed_public_models? // [] | index("goldencode")) != null and (.allowed_public_models | index("goldencode-local")) == null)
    ]
    | group_by(.credential_class)
    | map({class: .[0].credential_class, count: length})
  ' "$tmp/credentials.json")
  eligible_unified_backings=$(jq -n \
    --slurpfile credentials "$tmp/credentials.json" \
    --slurpfile unified "$tmp/unified.json" '
      [
        $unified[0].keys[].codex_gateway.key_prefix
        | select(. as $prefix | $credentials[0].credentials | any(.prefix == $prefix and ((.allowed_public_models? // [] | index("goldencode")) != null) and (.allowed_public_models | index("goldencode-local")) == null))
      ] | unique | length
    ')
  unified_backing_inactive=$(jq -n \
    --slurpfile credentials "$tmp/credentials-all.json" \
    --slurpfile unified "$tmp/unified.json" '
      [
        $unified[0].keys[].codex_gateway.key_prefix
        | select(. as $prefix | $credentials[0].credentials | any(.prefix == $prefix and .status != "active"))
      ] | length
    ')
  unified_backing_missing=$(jq -n \
    --slurpfile credentials "$tmp/credentials-all.json" \
    --slurpfile unified "$tmp/unified.json" '
      [
        $unified[0].keys[].codex_gateway.key_prefix
        | select(. as $prefix | ($credentials[0].credentials | any(.prefix == $prefix)) | not)
      ] | length
    ')
  unified_missing_or_restricted=$(jq -n \
    --slurpfile credentials "$tmp/credentials.json" \
    --slurpfile unified "$tmp/unified.json" '
      [
        $unified[0].keys[]
        | .codex_gateway.key_prefix as $prefix
        | ([ $credentials[0].credentials[] | select(.prefix == $prefix) ][0] // null) as $credential
        | select(
            $credential == null
            or (
              ($credential | has("allowed_public_models"))
              and (($credential.allowed_public_models | index("goldencode-local")) == null)
            )
          )
      ] | length
    ')

  echo "mode=$mode"
  echo "active_credentials=$active_total"
  echo "unrestricted_credentials=$unrestricted"
  echo "dual_model_credentials=$dual"
  echo "eligible_goldencode_only_credentials=$eligible"
  echo "eligible_credentials_by_class=$eligible_by_class"
  echo "other_restricted_credentials=$other_restricted"
  echo "active_unified_keys=$active_unified"
  echo "active_unified_backing_credentials=$active_unified_backings"
  echo "eligible_unified_backing_credentials=$eligible_unified_backings"
  echo "unified_keys_with_inactive_backing=$unified_backing_inactive"
  echo "unified_keys_with_missing_backing=$unified_backing_missing"
  echo "unified_keys_missing_or_without_local=$unified_missing_or_restricted"
}

snapshot
print_summary

if [ "$mode" = audit ]; then
  exit 0
fi

jq -r '
  .credentials[]
  | select(
      (.allowed_public_models? // [] | index("goldencode")) != null
      and (.allowed_public_models | index("goldencode-local")) == null
    )
  | [
      .prefix,
      (.allowed_public_models + ["goldencode-local"] | unique | join(","))
    ]
  | @tsv
' "$tmp/credentials.json" > "$tmp/candidates.tsv"
chmod 0600 "$tmp/candidates.tsv"

updated=0
while IFS="$(printf '\t')" read -r prefix models; do
  [ -n "$prefix" ] || continue
  admin update-key "$prefix" \
    --allowed-public-models "$models" \
    --no-entitlement-check >> "$tmp/update-audit.jsonl"
  updated=$((updated + 1))
done < "$tmp/candidates.tsv"

snapshot
remaining=$(jq '[.credentials[] | select((.allowed_public_models? // [] | index("goldencode")) != null and (.allowed_public_models | index("goldencode-local")) == null)] | length' "$tmp/credentials.json")
if [ "$remaining" -ne 0 ]; then
  echo "Authorization migration incomplete: $remaining eligible credentials remain." >&2
  exit 1
fi

echo "updated_credentials=$updated"
print_summary
