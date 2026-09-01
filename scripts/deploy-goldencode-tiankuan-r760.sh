#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: printf '<tiankuan-api-key>\\n' | $0 <candidate-gateway-image> <candidate-release-directory>" >&2
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
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/data/codex-gateway-r760/backups/pre-goldencode-tiankuan-$timestamp

IFS= read -r tiankuan_key
case "$tiankuan_key" in
  sk-[A-Za-z0-9_-][A-Za-z0-9_-]*) ;;
  *) echo "TianKuan API key read from stdin has an unexpected format." >&2; exit 2 ;;
esac
test "${#tiankuan_key}" -ge 24

case "$candidate_release" in
  "$gateway_root"/releases/*) ;;
  *) echo "Candidate release must be under $gateway_root/releases." >&2; exit 2 ;;
esac

candidate_release=$(readlink -f "$candidate_release")
candidate_revision=$(basename "$candidate_release")
old_current=$(readlink -f "$gateway_root/current")
old_previous=$(readlink -f "$gateway_root/previous")
test "$candidate_release" != "$old_current"
test -f "$candidate_release/compose.azure.yml"
test -f "$candidate_release/compose.research-production.yml"
test -x "$candidate_release/scripts/smoke-goldencode-dual-provider.sh"
test -r "$gateway_env"
test "$(stat -c '%a' "$gateway_env")" = 600
test -r "$gateway_override"
test -r "$research_compose_env"
test -r "$gateway_db"
docker image inspect "$candidate_image" >/dev/null
test "$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate_image")" = "$candidate_revision"
test "$(docker inspect -f '{{.State.Health.Status}}' "$qwen_container")" = healthy

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
rollback_tag=codex_gateway_r760-gateway:rollback-tiankuan-$timestamp
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
printf '%s' "$pre_audit" | jq -e '
  .integrity == "ok"
  and .foreign_key_violations == 0
  and .unfinished_reservations == 0
  and .active_research_runs == 0
' >/dev/null
pre_schema=$(printf '%s' "$pre_audit" | jq -er .schema)

registry=$(grep '^MEDCODE_PUBLIC_MODELS_JSON=' "$gateway_env" | cut -d= -f2-)
test -n "$registry"
registry_candidate=$(printf '%s' "$registry" | jq -ce '
  if (.goldencode.enabled != true or .goldencode.runtime != "pool") then
    error("goldencode must remain the enabled pool model")
  elif ([.goldencode["pool"].members[] | select(.id == "goldencode-tencent" and .runtime == "tencent" and .upstreamModel == "glm-5.3" and .enabled == true)] | length) != 1 then
    error("goldencode must contain the enabled Tencent GLM-5.3 member")
  elif ([.goldencode["pool"].members[] | select(.id == "goldencode-tiankuan" or .runtime == "tiankuan")] | length) != 0 then
    error("goldencode already contains a TianKuan member")
  else
    .goldencode["pool"].requireAllMembers = false
    | .goldencode["pool"].members += [{
        "id": "goldencode-tiankuan",
        "runtime": "tiankuan",
        "upstreamModel": "official/glm-5.3",
        "enabled": true
      }]
  end
')

env_candidate=$backup/gateway.container.env.candidate
awk -v registry="$registry_candidate" '
  BEGIN { models = 0 }
  /^MEDCODE_PUBLIC_MODELS_JSON=/ {
    print "MEDCODE_PUBLIC_MODELS_JSON=" registry
    models = 1
    next
  }
  /^MEDCODE_TIANKUAN_(API_KEY|API_KEY_FILE|BASE_URL|TIMEOUT_MS)=/ { next }
  { print }
  END { if (!models) exit 1 }
' "$gateway_env" > "$env_candidate"
printf '%s\n' \
  'MEDCODE_TIANKUAN_BASE_URL=https://tokens.tiankuan.com/v1' \
  'MEDCODE_TIANKUAN_TIMEOUT_MS=600000' >> "$env_candidate"
printf 'MEDCODE_TIANKUAN_API_KEY=%s\n' "$tiankuan_key" >> "$env_candidate"
tiankuan_key=
chmod 0600 "$env_candidate"

docker run --rm \
  --env-file "$env_candidate" \
  --entrypoint node \
  "$candidate_image" \
  --input-type=module -e '
    import { resolvePublicModelRegistry } from "/app/apps/gateway/dist/services/public-model-registry.js";
    const registry = resolvePublicModelRegistry(process.env);
    const model = registry.get("goldencode");
    if (!model || model.runtime !== "pool") throw new Error("Expected goldencode pool.");
    const members = model.pool?.members ?? [];
    if (members.length !== 2) throw new Error("Expected two goldencode pool members.");
    const tiankuan = members.find((member) => member.id === "goldencode-tiankuan");
    if (tiankuan?.runtime !== "tiankuan" || tiankuan.upstreamModel !== "official/glm-5.3") {
      throw new Error("TianKuan registry member mismatch.");
    }
    if (!process.env.MEDCODE_TIANKUAN_API_KEY?.trim()) throw new Error("TianKuan key missing.");
  '

docker run --rm \
  --network codex_gateway_r760_default \
  --env-file "$env_candidate" \
  --entrypoint node \
  "$candidate_image" \
  --input-type=module -e '
    const key = process.env.MEDCODE_TIANKUAN_API_KEY;
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    const models = await fetch("https://tokens.tiankuan.com/v1/models", {
      headers,
      signal: AbortSignal.timeout(30000)
    });
    const modelsJson = await models.json();
    if (!models.ok || !modelsJson.data?.some((model) => model.id === "official/glm-5.3")) {
      throw new Error("TianKuan model preflight failed.");
    }
    const chat = await fetch("https://tokens.tiankuan.com/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "official/glm-5.3",
        messages: [{ role: "user", content: "Reply exactly PREFLIGHT_OK." }],
        reasoning_effort: "low",
        max_tokens: 256,
        stream: false
      }),
      signal: AbortSignal.timeout(120000)
    });
    const chatJson = await chat.json();
    if (!chat.ok || chatJson.model !== "glm-5.3" || !chatJson.choices?.[0]?.message?.content) {
      throw new Error("TianKuan chat preflight failed.");
    }
    process.stdout.write("tiankuan_preflight=ok\n");
  '

compose_for "$candidate_release" config --quiet

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

BASE_URL=https://goldencode.instmarket.com.au:1443 \
  "$candidate_release/scripts/smoke-goldencode-dual-provider.sh" |
  tee "$backup/dual-provider-smoke.txt"

post_audit=$(db_audit "$candidate_image")
printf '%s\n' "$post_audit" > "$backup/post-db-audit.json"
printf '%s' "$post_audit" | jq -e \
  --argjson schema "$pre_schema" '
    .schema == $schema
    and .integrity == "ok"
    and .foreign_key_violations == 0
    and .unfinished_reservations == 0
    and .active_research_runs == 0
  ' >/dev/null

test "$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$gateway_container")" = "$candidate_revision"
test "$(docker inspect -f '{{.RestartCount}}' "$gateway_container")" = 0

cutover_started=0
trap - EXIT HUP INT TERM
echo "backup=$backup"
echo "release=$candidate_release"
echo "gateway_image=$(docker inspect -f '{{.Image}}' "$gateway_container")"
echo "schema=$pre_schema"
echo "goldencode_pool=tencent,tiankuan"
echo "research_containers=unchanged"
echo "qwen_container=unchanged"
echo "Gateway GoldenCode TianKuan dual-provider cutover completed."
