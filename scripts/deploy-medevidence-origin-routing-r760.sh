#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <candidate-gateway-image> <candidate-release-directory> <minimum-desktop-version>" >&2
  exit 2
fi

candidate_image=$1
candidate_release=$2
minimum_desktop_version=$3
gateway_root=/opt/codex-gateway-r760
gateway_shared=$gateway_root/shared/config
gateway_env=$gateway_shared/gateway.container.env
gateway_override=$gateway_shared/compose.r760.override.yml
research_compose_env=$gateway_shared/research.production.compose.env
gateway_container=codex_gateway_r760-gateway-1
gateway_db=/data/docker/volumes/codex_gateway_r760_gateway_state/_data/gateway.db
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/data/codex-gateway-r760/backups/pre-medevidence-origin-routing-$timestamp
policy_key=GATEWAY_MEDEVIDENCE_R760_MINIMUM_DESKTOP_VERSION

case "$candidate_release" in
  "$gateway_root"/releases/*) ;;
  *) echo "Candidate release must be under $gateway_root/releases." >&2; exit 2 ;;
esac

case "$minimum_desktop_version" in
  2.0.0-beta.47) ;;
  *) echo "This cutover is approved only for Desktop 2.0.0-beta.47." >&2; exit 2 ;;
esac

candidate_release=$(readlink -f "$candidate_release")
old_current=$(readlink -f "$gateway_root/current")
old_previous=$(readlink -f "$gateway_root/previous")
test "$candidate_release" != "$old_current"
test -f "$candidate_release/compose.azure.yml"
test -f "$candidate_release/compose.research-production.yml"
test -r "$gateway_env"
test -r "$gateway_override"
test -r "$research_compose_env"
test -r "$gateway_db"
docker image inspect "$candidate_image" >/dev/null

compose_for() {
  release=$1
  shift
  docker compose \
    --env-file "$research_compose_env" \
    -p codex_gateway_r760 \
    -f "$release/compose.azure.yml" \
    -f "$release/compose.research-production.yml" \
    -f "$gateway_override" \
    "$@"
}

db_audit() {
  image=$1
  docker run --rm \
    --volumes-from "$gateway_container" \
    --entrypoint node \
    "$image" \
    --input-type=module -e '
      import { DatabaseSync } from "node:sqlite";
      const gateway = new DatabaseSync("/var/lib/codex-gateway/gateway.db", { readonly: true });
      const research = new DatabaseSync("/var/lib/codex-gateway-research/research.db", { readonly: true });
      const one = (db, sql) => db.prepare(sql).get();
      const result = {
        schema: one(gateway, "select max(version) as value from schema_migrations").value,
        integrity: one(gateway, "pragma integrity_check").integrity_check,
        foreign_key_violations: gateway.prepare("pragma foreign_key_check").all().length,
        unfinished_reservations: one(gateway, "select count(*) as value from token_reservations where finalized_at is null").value,
        active_research_runs: one(research, "select count(*) as value from research_runs where status in ('"'"'queued'"'"','"'"'running'"'"')").value
      };
      gateway.close();
      research.close();
      process.stdout.write(`${JSON.stringify(result)}\n`);
    '
}

umask 077
mkdir -p "$backup"
cp -a "$gateway_env" "$backup/gateway.container.env"
cp -a "$gateway_override" "$backup/compose.r760.override.yml"
printf '%s\n' "$old_current" > "$backup/old-current.txt"
printf '%s\n' "$old_previous" > "$backup/old-previous.txt"

old_image_id=$(docker inspect -f '{{.Image}}' "$gateway_container")
old_started_at=$(docker inspect -f '{{.State.StartedAt}}' "$gateway_container")
old_restart_count=$(docker inspect -f '{{.RestartCount}}' "$gateway_container")
rollback_tag=codex_gateway_r760-gateway:rollback-medevidence-origin-$timestamp
docker tag "$old_image_id" "$rollback_tag"
printf '%s\n' "$old_image_id" > "$backup/old-gateway-image-id.txt"
printf '%s\n' "$rollback_tag" > "$backup/rollback-image-tag.txt"
printf '%s\n' "$old_started_at" > "$backup/old-gateway-started-at.txt"
printf '%s\n' "$old_restart_count" > "$backup/old-gateway-restart-count.txt"

unchanged_containers="codex_gateway_r760-research-llm-gateway-1 codex_gateway_r760-research-worker-1 codex_gateway_r760-research-maintenance-1 codex_gateway_r760-mihomo-1 qwen38-fp8-local"
for container in $unchanged_containers; do
  docker inspect -f '{{.Id}}' "$container" > "$backup/$container-id.txt"
done

pre_audit=$(db_audit "$old_image_id")
printf '%s\n' "$pre_audit" > "$backup/pre-db-audit.json"
printf '%s' "$pre_audit" | jq -e \
  '.integrity == "ok" and .foreign_key_violations == 0 and .unfinished_reservations == 0 and .active_research_runs == 0' \
  >/dev/null

env_candidate=$backup/gateway.container.env.candidate
awk -v key="$policy_key" -v value="$minimum_desktop_version" '
  BEGIN { replaced = 0 }
  index($0, key "=") == 1 {
    if (!replaced) print key "=" value
    replaced = 1
    next
  }
  { print }
  END { if (!replaced) print key "=" value }
' "$gateway_env" > "$env_candidate"
chmod 0600 "$env_candidate"
test "$(grep -c "^$policy_key=" "$env_candidate")" -eq 1
test "$(sed -n "s/^$policy_key=//p" "$env_candidate")" = "$minimum_desktop_version"

docker run --rm \
  -e "$policy_key=$minimum_desktop_version" \
  --entrypoint node \
  "$candidate_image" \
  --input-type=module -e '
    import {
      phoneAuthLegacyMedevidenceOrigin,
      phoneAuthR760MedevidenceOrigin,
      resolveMedevidenceOriginPolicy,
      selectMedevidenceOrigin
    } from "/app/apps/gateway/dist/medevidence-origin-policy.js";
    const policy = resolveMedevidenceOriginPolicy(process.env);
    const cases = [
      [null, phoneAuthLegacyMedevidenceOrigin],
      ["invalid", phoneAuthLegacyMedevidenceOrigin],
      ["2.0.0-beta.46", phoneAuthLegacyMedevidenceOrigin],
      ["2.0.0-beta.47", phoneAuthR760MedevidenceOrigin]
    ];
    for (const [version, expected] of cases) {
      const actual = selectMedevidenceOrigin(null, version, policy, true);
      if (actual !== expected) throw new Error(`Unexpected route for ${version}: ${actual}`);
    }
  '

cutover_started=0
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$cutover_started" -eq 1 ]; then
    set +e
    install -m 0600 "$backup/gateway.container.env" "$gateway_env"
    ln -sfn "$old_current" "$gateway_root/current"
    ln -sfn "$old_previous" "$gateway_root/previous"
    docker tag "$old_image_id" codex_gateway_r760-gateway:latest
    compose_for "$old_current" up -d --no-deps --force-recreate gateway
    echo "Gateway cutover failed; previous env, release pointers, and image were restored." >&2
  fi
  exit "$status"
}
trap rollback EXIT HUP INT TERM

cutover_started=1
install -m 0600 "$env_candidate" "$gateway_env"
compose_for "$candidate_release" config --quiet

docker stop "$gateway_container" >/dev/null
cp -a "$gateway_db" "$backup/gateway.db"
for suffix in -wal -shm; do
  if [ -f "$gateway_db$suffix" ]; then
    cp -a "$gateway_db$suffix" "$backup/gateway.db$suffix"
  fi
done

ln -sfn "$old_current" "$gateway_root/previous"
ln -sfn "$candidate_release" "$gateway_root/current"
docker tag "$candidate_image" codex_gateway_r760-gateway:latest
compose_for "$candidate_release" up -d --no-deps --force-recreate gateway

attempt=0
until [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$gateway_container" 2>/dev/null || true)" = healthy ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Gateway did not become healthy within 5 minutes." >&2
    exit 1
  fi
  sleep 5
done

health=$(curl -fsS --max-time 15 http://127.0.0.1:18787/gateway/health)
printf '%s' "$health" | jq -e \
  --arg version "$minimum_desktop_version" \
  '.medevidence_routing.mode == "versioned" and .medevidence_routing.r760_minimum_desktop_version == $version' \
  >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:18787/v1/models)" = 401
test "$(docker exec "$gateway_container" printenv "$policy_key")" = "$minimum_desktop_version"
docker inspect -f '{{json .NetworkSettings.Networks}}' "$gateway_container" |
  jq -e 'has("codex_gateway_r760_default") and has("qwen_api_gateway_r760_qwen_private")' >/dev/null

for container in $unchanged_containers; do
  test "$(docker inspect -f '{{.Id}}' "$container")" = "$(cat "$backup/$container-id.txt")"
done

post_audit=$(db_audit "$candidate_image")
printf '%s\n' "$post_audit" > "$backup/post-db-audit.json"
printf '%s' "$post_audit" | jq -e \
  --argjson before "$pre_audit" \
  '.schema == $before.schema and .integrity == "ok" and .foreign_key_violations == 0 and .unfinished_reservations == 0 and .active_research_runs == 0' \
  >/dev/null

cutover_started=0
trap - EXIT HUP INT TERM
echo "backup=$backup"
echo "release=$candidate_release"
echo "gateway_image=$(docker inspect -f '{{.Image}}' "$gateway_container")"
echo "minimum_desktop_version=$minimum_desktop_version"
echo "database_metadata_migrated=false"
echo "tokens_rotated=false"
echo "non_gateway_containers=unchanged"
echo "Gateway MedEvidence origin routing cutover completed."
