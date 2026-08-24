#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <candidate-gateway-image> <candidate-release-directory>" >&2
  exit 2
fi

candidate_image=$1
candidate_release=$2
gateway_root=/opt/codex-gateway-r760
gateway_shared=$gateway_root/shared/config
gateway_env=$gateway_shared/gateway.container.env
gateway_override=$gateway_shared/compose.r760.override.yml
research_compose_env=$gateway_shared/research.production.compose.env
gateway_container=codex_gateway_r760-gateway-1
gateway_db=/data/docker/volumes/codex_gateway_r760_gateway_state/_data/gateway.db
qwen_container=qwen38-fp8-local
qwen_network=qwen_api_gateway_r760_qwen_private
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/data/codex-gateway-r760/backups/pre-reasoning-effort-p0-$timestamp

case "$candidate_release" in
  "$gateway_root"/releases/*) ;;
  *) echo "Candidate release must be under $gateway_root/releases." >&2; exit 2 ;;
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
docker network inspect "$qwen_network" >/dev/null
test "$(docker inspect -f '{{.State.Health.Status}}' "$qwen_container")" = healthy
docker exec "$qwen_container" python3 -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).read()"
grep -q "name: $qwen_network" "$gateway_override"

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
rollback_tag=codex_gateway_r760-gateway:rollback-reasoning-p0-$timestamp
docker tag "$old_image_id" "$rollback_tag"
printf '%s\n' "$old_image_id" > "$backup/old-gateway-image-id.txt"
printf '%s\n' "$rollback_tag" > "$backup/rollback-image-tag.txt"
printf '%s\n' "$old_started_at" > "$backup/old-gateway-started-at.txt"
printf '%s\n' "$old_restart_count" > "$backup/old-gateway-restart-count.txt"

for service in research-llm-gateway research-worker research-maintenance mihomo; do
  container=codex_gateway_r760-$service-1
  docker inspect -f '{{.Id}}' "$container" > "$backup/$service-container-id.txt"
done
docker inspect -f '{{.Id}}' "$qwen_container" > "$backup/qwen-container-id.txt"

pre_audit=$(db_audit "$old_image_id")
printf '%s\n' "$pre_audit" > "$backup/pre-db-audit.json"
printf '%s' "$pre_audit" | jq -e \
  '.integrity == "ok" and .foreign_key_violations == 0 and .unfinished_reservations == 0 and .active_research_runs == 0' \
  >/dev/null

registry=$(grep '^MEDCODE_PUBLIC_MODELS_JSON=' "$gateway_env" | cut -d= -f2-)
test -n "$registry"
registry_candidate=$(printf '%s' "$registry" | jq -ce '
  if (.goldencode.enabled != true or .goldencode.runtime != "pool") then
    error("goldencode must remain the enabled pool model")
  elif (.goldencode["pool"].members | length) != 1
       or .goldencode["pool"].members[0].runtime != "tencent"
       or .goldencode["pool"].members[0].upstreamModel != "glm-5.3" then
    error("goldencode must remain the single Tencent GLM-5.3 member")
  elif (.goldencode_local? != null) then
    error("unexpected model key; public ID must remain goldencode-local")
  else
    .goldencode.reasoning.effort = "high"
    | .goldencode.reasoning.supportedEfforts = ["low", "high", "max"]
    | .goldencode.reasoning.legacyAliases = {"none":"low", "medium":"high"}
  end
')

env_candidate=$backup/gateway.container.env.candidate
awk -v registry="$registry_candidate" '
  BEGIN { replaced = 0 }
  /^MEDCODE_PUBLIC_MODELS_JSON=/ {
    print "MEDCODE_PUBLIC_MODELS_JSON=" registry
    replaced = 1
    next
  }
  { print }
  END { if (!replaced) exit 1 }
' "$gateway_env" > "$env_candidate"
chmod 0600 "$env_candidate"

docker run --rm \
  --env-file "$env_candidate" \
  --entrypoint node \
  "$candidate_image" \
  --input-type=module -e '
    import { resolvePublicModelRegistry } from "/app/apps/gateway/dist/services/public-model-registry.js";
    const registry = resolvePublicModelRegistry(process.env);
    const model = registry.get("goldencode");
    const local = registry.get("goldencode-local");
    if (!model || !local) throw new Error("Expected both public models.");
    const expected = JSON.stringify({supportedEfforts:["low","high","max"],legacyAliases:{none:"low",medium:"high"}});
    const actual = JSON.stringify({supportedEfforts:model.reasoning?.supportedEfforts,legacyAliases:model.reasoning?.legacyAliases});
    if (actual !== expected) throw new Error("Reasoning compatibility registry mismatch.");
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

curl -fsS --max-time 15 http://127.0.0.1:18787/gateway/health >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:18787/v1/models)" = 401
docker inspect -f '{{json .NetworkSettings.Networks}}' "$gateway_container" |
  jq -e 'has("codex_gateway_r760_default") and has("qwen_api_gateway_r760_qwen_private")' >/dev/null
test "$(docker inspect -f '{{.State.Health.Status}}' "$qwen_container")" = healthy

for service in research-llm-gateway research-worker research-maintenance mihomo; do
  container=codex_gateway_r760-$service-1
  test "$(docker inspect -f '{{.Id}}' "$container")" = "$(cat "$backup/$service-container-id.txt")"
done
test "$(docker inspect -f '{{.Id}}' "$qwen_container")" = "$(cat "$backup/qwen-container-id.txt")"

post_audit=$(db_audit "$candidate_image")
printf '%s\n' "$post_audit" > "$backup/post-db-audit.json"
printf '%s' "$post_audit" | jq -e \
  '.schema == 27 and .integrity == "ok" and .foreign_key_violations == 0 and .unfinished_reservations == 0 and .active_research_runs == 0' \
  >/dev/null

cutover_started=0
trap - EXIT HUP INT TERM
echo "backup=$backup"
echo "release=$candidate_release"
echo "gateway_image=$(docker inspect -f '{{.Image}}' "$gateway_container")"
echo "schema=27"
echo "research_containers=unchanged"
echo "qwen_container=unchanged"
echo "Gateway reasoning-effort P0 cutover completed."
