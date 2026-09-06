#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: printf '<llada-api-key>\\n' | $0 <candidate-gateway-image> <candidate-release-directory>" >&2
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
backup=/data/codex-gateway-r760/backups/pre-llada-image-primary-$timestamp

IFS= read -r llada_key
case "$llada_key" in
  sk-[A-Za-z0-9_-][A-Za-z0-9_-]*) ;;
  *) echo "LLaDA API key read from stdin has an unexpected format." >&2; exit 2 ;;
esac
test "${#llada_key}" -ge 24

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
test -x "$candidate_release/scripts/smoke-llada-image-r760.sh"
test -r "$gateway_env"
test "$(stat -c '%a' "$gateway_env")" = 600
test -r "$gateway_override"
test -r "$research_compose_env"
test -r "$gateway_db"
docker image inspect "$candidate_image" >/dev/null
test "$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate_image")" = "$candidate_revision"
test "$(docker inspect -f '{{.State.Health.Status}}' "$qwen_container")" = healthy

for config_name in \
  gateway.container.env \
  research.production.api.env \
  research.production.compose.env \
  research.production.goldencode.r760.json \
  research.production.llm-gateway.env \
  research.production.worker.env; do
  shared_path=$gateway_shared/$config_name
  release_path=$candidate_release/config/$config_name
  test -r "$shared_path"
  if [ -L "$release_path" ]; then
    test "$(readlink -f "$release_path")" = "$shared_path"
  else
    test ! -e "$release_path"
    ln -s "$shared_path" "$release_path"
  fi
done

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
      const now = new Date();
      const staleSoftWriteBefore = new Date(now.getTime() - 60 * 60_000);
      const result = {
        schema: one(gateway, "select max(version) as value from schema_migrations").value,
        integrity: one(gateway, "pragma integrity_check").integrity_check,
        foreign_key_violations: gateway.prepare("pragma foreign_key_check").all().length,
        unfinished_reservations: one(gateway, "select count(*) as value from token_reservations where finalized_at is null").value,
        stale_reservations: gateway.prepare(`
          select count(*) as value
          from token_reservations
          where finalized_at is null
            and (
              (kind = ? and expires_at is not null and expires_at <= ?)
              or (kind = ? and created_at <= ?)
            )
        `).get("reservation", now.toISOString(), "soft_write", staleSoftWriteBefore.toISOString()).value,
        active_research_runs: research
          .prepare("select count(*) as value from research_runs where status in (?, ?)")
          .get("queued", "running").value
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
rollback_tag=codex_gateway_r760-gateway:rollback-llada-image-$timestamp
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
  and .stale_reservations == 0
  and .active_research_runs == 0
' >/dev/null
pre_schema=$(printf '%s' "$pre_audit" | jq -er .schema)

env_candidate=$backup/gateway.container.env.candidate
awk '
  BEGIN { image_models = 0; request_timeout = 0; provider_timeout = 0 }
  /^MEDCODE_IMAGE_MODEL_MAP_JSON=/ {
    print "MEDCODE_IMAGE_MODEL_MAP_JSON={\"medcode-image-default\":\"llada-image-turbo-fp8\"}"
    image_models = 1
    next
  }
  /^MEDCODE_IMAGE_REQUEST_TIMEOUT_MS=/ {
    print "MEDCODE_IMAGE_REQUEST_TIMEOUT_MS=240000"
    request_timeout = 1
    next
  }
  /^MEDCODE_IMAGE_TIMEOUT_MS=/ {
    print "MEDCODE_IMAGE_TIMEOUT_MS=90000"
    provider_timeout = 1
    next
  }
  /^MEDCODE_IMAGE_PRIMARY_PROVIDER=/ { next }
  /^MEDCODE_IMAGE_LLADA_(API_KEY|BASE_URL|TIMEOUT_MS)=/ { next }
  /^MEDCODE_IMAGE_OPENAI_MODEL=/ { next }
  { print }
  END {
    if (!image_models) print "MEDCODE_IMAGE_MODEL_MAP_JSON={\"medcode-image-default\":\"llada-image-turbo-fp8\"}"
    if (!request_timeout) print "MEDCODE_IMAGE_REQUEST_TIMEOUT_MS=240000"
    if (!provider_timeout) print "MEDCODE_IMAGE_TIMEOUT_MS=90000"
  }
' "$gateway_env" > "$env_candidate"
printf '%s\n' \
  'MEDCODE_IMAGE_PRIMARY_PROVIDER=llada' \
  'MEDCODE_IMAGE_LLADA_BASE_URL=https://image-api.instmarket.com.au' \
  'MEDCODE_IMAGE_LLADA_TIMEOUT_MS=90000' \
  'MEDCODE_IMAGE_OPENAI_MODEL=gpt-image-2' >> "$env_candidate"
printf 'MEDCODE_IMAGE_LLADA_API_KEY=%s\n' "$llada_key" >> "$env_candidate"
llada_key=
chmod 0600 "$env_candidate"
test "$(grep -v '^MEDCODE_IMAGE_' "$gateway_env" | sha256sum | cut -d' ' -f1)" = \
  "$(grep -v '^MEDCODE_IMAGE_' "$env_candidate" | sha256sum | cut -d' ' -f1)"

docker run --rm \
  --env-file "$env_candidate" \
  --entrypoint node \
  "$candidate_image" \
  --input-type=module -e '
    import { validateRuntimeEnvironment } from "/app/apps/gateway/dist/index.js";
    import { parseImageModelMap } from "/app/apps/gateway/dist/image-generation.js";
    validateRuntimeEnvironment(process.env);
    const imageModels = parseImageModelMap(process.env.MEDCODE_IMAGE_MODEL_MAP_JSON);
    if (process.env.MEDCODE_IMAGE_PRIMARY_PROVIDER !== "llada") throw new Error("LLaDA primary mismatch.");
    if (imageModels["medcode-image-default"] !== "llada-image-turbo-fp8") {
      throw new Error("LLaDA model map mismatch.");
    }
    if (!process.env.MEDCODE_IMAGE_OPENAI_API_KEY?.trim()) throw new Error("GPT Image 2 fallback key missing.");
  '

docker run --rm \
  --network codex_gateway_r760_default \
  --env-file "$env_candidate" \
  --entrypoint node \
  "$candidate_image" \
  --input-type=module -e '
    const base = process.env.MEDCODE_IMAGE_LLADA_BASE_URL;
    const key = process.env.MEDCODE_IMAGE_LLADA_API_KEY;
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(30000) });
    const healthJson = await health.json();
    if (!health.ok || healthJson.status !== "ok") throw new Error("LLaDA health preflight failed.");
    const models = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000)
    });
    const modelsJson = await models.json();
    if (!models.ok || !modelsJson.data?.some((model) => model.id === "llada-image-turbo-fp8")) {
      throw new Error("LLaDA model preflight failed.");
    }
    process.stdout.write("llada_preflight=ok\n");
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

if ! BASE_URL=https://goldencode.instmarket.com.au:1443 \
  "$candidate_release/scripts/smoke-llada-image-r760.sh" \
  > "$backup/llada-image-smoke.txt"; then
  cat "$backup/llada-image-smoke.txt"
  exit 1
fi
cat "$backup/llada-image-smoke.txt"

post_audit=$(db_audit "$candidate_image")
printf '%s\n' "$post_audit" > "$backup/post-db-audit.json"
printf '%s' "$post_audit" | jq -e \
  --argjson schema "$pre_schema" '
    .schema == $schema
    and .integrity == "ok"
    and .foreign_key_violations == 0
    and .stale_reservations == 0
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
echo "goldencode_pool=unchanged"
echo "non_image_config=unchanged"
echo "image_primary=llada-image-turbo-fp8"
echo "image_first_fallback=gpt-image-2"
echo "research_containers=unchanged"
echo "qwen_container=unchanged"
echo "Gateway LLaDA image primary cutover completed."
