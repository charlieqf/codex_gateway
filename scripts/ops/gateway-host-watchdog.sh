#!/usr/bin/env bash
set -euo pipefail

umask 077

container="${WATCHDOG_CONTAINER:-codex_gateway_test-gateway-1}"
state_dir="${WATCHDOG_STATE_DIR:-/var/lib/codex-gateway-watchdog}"
gateway_url="${WATCHDOG_GATEWAY_HEALTH_URL:-http://127.0.0.1:18787/gateway/health}"
allowed_codex_concurrency="${WATCHDOG_ALLOWED_CODEX_CONCURRENCY:-2}"
dry_run=0
no_notify=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --no-notify) no_notify=1 ;;
    --state-dir)
      shift
      state_dir="${1:?--state-dir requires a path}"
      ;;
    --container)
      shift
      container="${1:?--container requires a name}"
      ;;
    *)
      echo "watchdog_error=unknown_argument argument=$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "${dry_run}" -ne 1 ] || [ "${no_notify}" -ne 1 ]; then
  echo "watchdog_error=notifications_not_implemented use=--dry-run_--no-notify" >&2
  exit 2
fi

for command in docker timeout curl flock awk df base64; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "watchdog_error=missing_command command=${command}" >&2
    exit 2
  fi
done

mkdir -p "${state_dir}"
chmod 0700 "${state_dir}"
exec 9>"${state_dir}/watchdog.lock"
if ! flock -n 9; then
  echo 'watchdog_status=skipped reason=already_running'
  exit 0
fi

work_dir="$(mktemp -d "${state_dir}/run.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

state_file="${state_dir}/state.json"
previous_base64=""
if [ -s "${state_file}" ]; then
  previous_base64="$(base64 -w 0 "${state_file}")"
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

health_http=0
health_total_ms=0
health_ready=false
if health_meta="$(curl -sS --connect-timeout 5 --max-time 10 \
  -o "${work_dir}/health.json" -w '%{http_code} %{time_total}' "${gateway_url}" 2>/dev/null)"; then
  read -r health_http health_total_seconds <<<"${health_meta}"
  health_http="$((10#${health_http}))"
  health_total_ms="$(awk -v value="${health_total_seconds}" 'BEGIN { printf "%d", value * 1000 }')"
  if [ "${health_http}" = "200" ] && grep -Eq '"state"[[:space:]]*:[[:space:]]*"ready"' "${work_dir}/health.json"; then
    health_ready=true
  fi
fi

mem_available_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
mem_available_bytes="$((mem_available_kb * 1024))"
memory_psi_supported=false
memory_psi_some=0
memory_psi_full=0
if [ -r /proc/pressure/memory ]; then
  memory_psi_supported=true
  memory_psi_some="$(awk '/^some / {for (i=1;i<=NF;i++) if ($i ~ /^avg60=/) {split($i,a,"="); print a[2]}}' /proc/pressure/memory)"
  memory_psi_full="$(awk '/^full / {for (i=1;i<=NF;i++) if ($i ~ /^avg60=/) {split($i,a,"="); print a[2]}}' /proc/pressure/memory)"
fi

read -r disk_size_bytes disk_used_bytes disk_available_bytes disk_used_percent_raw < <(
  df -B1 --output=size,used,avail,pcent / | awk 'NR == 2 {print $1, $2, $3, $4}'
)
disk_used_percent="${disk_used_percent_raw%%%}"
inode_used_percent_raw="$(df -i / | awk 'NR == 2 {print $5}')"
inode_used_percent="${inode_used_percent_raw%%%}"
vcpus="$(nproc)"
load1="$(awk '{print $1}' /proc/loadavg)"

container_status=unavailable
container_health=unknown
restart_count=0
oom_killed=false
container_memory_bytes=0
container_pids=0
codex_children=0
temporary_status=container_introspection_unavailable
temporary_count=0
temporary_total=0
temporary_largest=0
temporary_oldest=0
primary_db=0
primary_wal=0
plus_db=0
plus_wal=0
quarantine=0
ops_json=null

if inspect="$(timeout 10 docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}' "${container}" 2>/dev/null)"; then
  IFS='|' read -r raw_status raw_health restart_count oom_value <<<"${inspect}"
  container_status=ok
  container_health="$(printf '%s' "${raw_health}" | tr -cd 'a-zA-Z0-9._-')"
  [ "${oom_value}" = "true" ] && oom_killed=true

  if cgroup="$(timeout 10 docker exec "${container}" sh -lc 'printf "%s %s\n" "$(cat /sys/fs/cgroup/memory.current)" "$(cat /sys/fs/cgroup/pids.current)"' 2>/dev/null)"; then
    read -r container_memory_bytes container_pids <<<"${cgroup}"
  fi
  codex_children="$(docker top "${container}" 2>/dev/null | tail -n +2 | grep -c 'codex-gateway-exec' || true)"

  if temporary="$(timeout 10 docker exec "${container}" sh -lc '
    count=0; total=0; largest=0; oldest=0; now=$(date +%s)
    for path in /tmp/codex-gateway-state-*; do
      [ -d "$path" ] || continue
      count=$((count + 1))
      size=$(du -sb "$path" 2>/dev/null | awk "{print \$1}")
      mtime=$(stat -c %Y "$path")
      age=$((now - mtime))
      total=$((total + size))
      [ "$size" -gt "$largest" ] && largest=$size
      [ "$age" -gt "$oldest" ] && oldest=$age
    done
    printf "%s %s %s %s\n" "$count" "$total" "$largest" "$oldest"
  ' 2>/dev/null)"; then
    temporary_status=ok
    read -r temporary_count temporary_total temporary_largest temporary_oldest <<<"${temporary}"
  fi

  if persistent="$(timeout 10 docker exec "${container}" sh -lc '
    size() { if [ -f "$1" ]; then stat -c %s "$1"; else printf 0; fi; }
    printf "%s %s %s %s " \
      "$(size /var/lib/codex-gateway/codex-home/state_5.sqlite)" \
      "$(size /var/lib/codex-gateway/codex-home/state_5.sqlite-wal)" \
      "$(size /var/lib/codex-gateway/codex-home-plus/state_5.sqlite)" \
      "$(size /var/lib/codex-gateway/codex-home-plus/state_5.sqlite-wal)"
    du -sb /var/lib/codex-gateway/codex-rollout-quarantine 2>/dev/null | awk "{print \$1}" || printf 0
  ' 2>/dev/null)"; then
    read -r primary_db primary_wal plus_db plus_wal quarantine <<<"${persistent}"
  fi

  if timeout 10 docker exec "${container}" node apps/admin-cli/dist/index.js \
    --db /var/lib/codex-gateway/gateway.db ops-snapshot \
    --runtime-snapshot /var/lib/codex-gateway/ops-runtime.json \
    >"${work_dir}/ops.json" 2>"${work_dir}/ops.err"; then
    ops_json="$(<"${work_dir}/ops.json")"
  fi
fi

cat >"${work_dir}/input.json" <<EOF
{
  "schemaVersion": 1,
  "generatedAt": "${now}",
  "gatewayHealth": {"status":"ok","httpStatus":${health_http},"ready":${health_ready},"totalMs":${health_total_ms}},
  "host": {
    "memAvailableBytes": ${mem_available_bytes},
    "memoryPsiSupported": ${memory_psi_supported},
    "memoryPsiSomeAvg60": ${memory_psi_some:-0},
    "memoryPsiFullAvg60": ${memory_psi_full:-0},
    "diskSizeBytes": ${disk_size_bytes},
    "diskUsedBytes": ${disk_used_bytes},
    "diskUsedPercent": ${disk_used_percent},
    "diskAvailableBytes": ${disk_available_bytes},
    "inodeUsedPercent": ${inode_used_percent},
    "load1": ${load1},
    "vcpus": ${vcpus}
  },
  "container": {
    "status": "${container_status}",
    "health": "${container_health}",
    "restartCount": ${restart_count},
    "oomKilled": ${oom_killed},
    "memoryBytes": ${container_memory_bytes},
    "pids": ${container_pids},
    "codexChildren": ${codex_children},
    "allowedCodexConcurrency": ${allowed_codex_concurrency}
  },
  "temporaryState": {
    "status": "${temporary_status}",
    "count": ${temporary_count},
    "totalBytes": ${temporary_total},
    "largestBytes": ${temporary_largest},
    "oldestAgeSeconds": ${temporary_oldest}
  },
  "persistentState": {
    "primaryDbBytes": ${primary_db},
    "primaryWalBytes": ${primary_wal},
    "plusDbBytes": ${plus_db},
    "plusWalBytes": ${plus_wal},
    "quarantineBytes": ${quarantine}
  },
  "ops": ${ops_json},
  "previousBase64": "${previous_base64}"
}
EOF

degraded_fallback() {
  local reason="$1"
  local severity=warning
  if [ "${disk_used_percent}" -ge 92 ] || [ "${disk_available_bytes}" -le $((6 * 1024 * 1024 * 1024)) ] || [ "${mem_available_bytes}" -lt $((750 * 1024 * 1024)) ]; then
    severity=emergency
  elif [ "${disk_used_percent}" -ge 85 ] || [ "${disk_available_bytes}" -le $((12 * 1024 * 1024 * 1024)) ] || [ "${mem_available_bytes}" -lt $((1536 * 1024 * 1024)) ]; then
    severity=critical
  fi
  cat >"${work_dir}/degraded.json" <<EOF
{"schemaVersion":1,"generatedAt":"${now}","mode":"no-notify","status":"${severity}","reason":"${reason}","host":{"memAvailableBytes":${mem_available_bytes},"diskUsedPercent":${disk_used_percent},"diskAvailableBytes":${disk_available_bytes}},"statePreserved":true}
EOF
  chmod 0600 "${work_dir}/degraded.json"
  mv -f "${work_dir}/degraded.json" "${state_dir}/last-degraded.json"
  echo "watchdog_status=${severity} findings=1 new=${reason} escalated=none resolved=none notify=false state_preserved=true"
}

if [ "${container_status}" = "unavailable" ]; then
  degraded_fallback container.collection
  exit 0
fi

if ! timeout 10 docker exec -i "${container}" node /app/scripts/ops/gateway-request-watchdog.mjs --input - \
  <"${work_dir}/input.json" >"${work_dir}/result.json" 2>"${work_dir}/evaluator.err"; then
  degraded_fallback gateway.evaluator
  exit 0
fi

chmod 0600 "${work_dir}/result.json"
mv -f "${work_dir}/result.json" "${state_file}"

timeout 10 docker exec -i "${container}" node -e '
  let s="";
  process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => {
    const x = JSON.parse(s);
    const keys = (items) => items.map(item => item.key).join(",") || "none";
    console.log(`watchdog_status=${x.status} findings=${x.findings.length} new=${keys(x.events.new)} escalated=${keys(x.events.escalated)} resolved=${keys(x.events.resolved)} notify=false`);
  });
' <"${state_file}"
