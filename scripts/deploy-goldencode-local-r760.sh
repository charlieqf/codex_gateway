#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <gateway-image> <public-models.json> <gateway-override.yml> <qwen-compose.yml>" >&2
  exit 2
fi

gateway_image=$1
models_file=$2
override_file=$3
qwen_compose_file=$4
gateway_root=/opt/codex-gateway-r760
gateway_release=$gateway_root/current
gateway_shared=$gateway_root/shared/config
gateway_env=$gateway_shared/gateway.container.env
gateway_override=$gateway_shared/compose.r760.override.yml
research_compose_env=$gateway_shared/research.production.compose.env
qwen_root=/data/llm-runtime/qwen-api
gateway_container=codex_gateway_r760-gateway-1
gateway_db=/data/docker/volumes/codex_gateway_r760_gateway_state/_data/gateway.db
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$qwen_root/backups/goldencode-local-$timestamp

test -r "$models_file"
test -r "$override_file"
test -r "$qwen_compose_file"
test -r "$gateway_env"
test -r "$gateway_override"
test -r "$research_compose_env"
test -r "$gateway_db"
docker image inspect "$gateway_image" >/dev/null
docker network inspect qwen_api_gateway_r760_qwen_private >/dev/null
test "$(docker inspect -f '{{.State.Health.Status}}' qwen38-fp8-local)" = healthy
docker exec qwen38-fp8-local python3 -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).read()"

umask 077
mkdir -p "$backup"
cp -a "$gateway_env" "$backup/gateway.container.env"
cp -a "$gateway_override" "$backup/compose.r760.override.yml"
cp -a "$qwen_root/compose.yml" "$backup/qwen-compose.yml"

registry=$(jq -c . "$models_file")
env_candidate=$backup/gateway.container.env.candidate
awk -v registry="$registry" '
  BEGIN { models = 0; base = 0; timeout = 0 }
  /^MEDCODE_PUBLIC_MODELS_JSON=/ {
    print "MEDCODE_PUBLIC_MODELS_JSON=" registry
    models = 1
    next
  }
  /^MEDCODE_LOCAL_OPENAI_BASE_URL=/ {
    print "MEDCODE_LOCAL_OPENAI_BASE_URL=http://qwen38-fp8:8000/v1"
    base = 1
    next
  }
  /^MEDCODE_LOCAL_OPENAI_TIMEOUT_MS=/ {
    print "MEDCODE_LOCAL_OPENAI_TIMEOUT_MS=900000"
    timeout = 1
    next
  }
  { print }
  END {
    if (!models) print "MEDCODE_PUBLIC_MODELS_JSON=" registry
    if (!base) print "MEDCODE_LOCAL_OPENAI_BASE_URL=http://qwen38-fp8:8000/v1"
    if (!timeout) print "MEDCODE_LOCAL_OPENAI_TIMEOUT_MS=900000"
  }
' "$gateway_env" > "$env_candidate"
chmod 0600 "$env_candidate"
grep -q '^MEDCODE_PUBLIC_MODELS_JSON=' "$env_candidate"
grep -q '^MEDCODE_LOCAL_OPENAI_BASE_URL=http://qwen38-fp8:8000/v1$' "$env_candidate"
grep -q '^MEDCODE_LOCAL_OPENAI_TIMEOUT_MS=900000$' "$env_candidate"

override_candidate=$backup/compose.r760.override.yml.candidate
install -m 0644 "$override_file" "$override_candidate"
install -m 0644 "$qwen_compose_file" "$backup/qwen-compose.yml.candidate"

compose() {
  docker compose \
    --env-file "$research_compose_env" \
    -p codex_gateway_r760 \
    -f "$gateway_release/compose.azure.yml" \
    -f "$gateway_release/compose.research-production.yml" \
    -f "$gateway_override" \
    "$@"
}

docker compose \
  --env-file "$research_compose_env" \
  -p codex_gateway_r760 \
  -f "$gateway_release/compose.azure.yml" \
  -f "$gateway_release/compose.research-production.yml" \
  -f "$override_candidate" \
  config --quiet
docker compose -p qwen_api_gateway_r760 -f "$qwen_compose_file" config --quiet

old_image_id=$(docker inspect -f '{{.Image}}' "$gateway_container")
old_started_at=$(docker inspect -f '{{.State.StartedAt}}' "$gateway_container")
old_restart_count=$(docker inspect -f '{{.RestartCount}}' "$gateway_container")
printf '%s\n' "$old_image_id" > "$backup/old-gateway-image-id.txt"
printf '%s\n' "$old_started_at" > "$backup/old-gateway-started-at.txt"
printf '%s\n' "$old_restart_count" > "$backup/old-gateway-restart-count.txt"

cutover_started=1
rollback() {
  status=$?
  if [ "$cutover_started" -eq 1 ]; then
    set +e
    install -m 0600 "$backup/gateway.container.env" "$gateway_env"
    install -m 0644 "$backup/compose.r760.override.yml" "$gateway_override"
    docker tag "$old_image_id" codex_gateway_r760-gateway:latest
    compose up -d --no-deps --force-recreate gateway
    echo "Gateway cutover failed; the previous env, override, and image were restored." >&2
  fi
  exit "$status"
}
trap rollback EXIT HUP INT TERM

docker stop "$gateway_container" >/dev/null
cp -a "$gateway_db" "$backup/gateway.db"
for suffix in -wal -shm; do
  if [ -f "$gateway_db$suffix" ]; then
    cp -a "$gateway_db$suffix" "$backup/gateway.db$suffix"
  fi
done

install -m 0600 "$env_candidate" "$gateway_env"
install -m 0644 "$override_candidate" "$gateway_override"
install -m 0644 "$qwen_compose_file" "$qwen_root/compose.yml"
docker tag "$gateway_image" codex_gateway_r760-gateway:latest
docker compose -p qwen_api_gateway_r760 -f "$qwen_root/compose.yml" up -d qwen38-fp8
compose up -d --no-deps --force-recreate gateway

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
test "$(docker inspect -f '{{.State.Health.Status}}' qwen38-fp8-local)" = healthy

cutover_started=0
trap - EXIT HUP INT TERM
echo "backup=$backup"
echo "gateway_image=$(docker inspect -f '{{.Image}}' "$gateway_container")"
echo "Gateway goldencode-local cutover completed."
