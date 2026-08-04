#!/usr/bin/env bash
set -euo pipefail

edge_ip="${EDGE_IP:-47.116.7.37}"
host="gw.instmarket.com.au"
base_url="https://${host}"

IFS= read -r chat_token_b64
IFS= read -r research_token_b64
chat_token_b64="${chat_token_b64%$'\r'}"
research_token_b64="${research_token_b64%$'\r'}"

if [ -z "$chat_token_b64" ] || [ -z "$research_token_b64" ]; then
    echo "error=missing_smoke_credentials" >&2
    exit 1
fi

chat_token="$(printf '%s' "$chat_token_b64" | base64 -d)"
research_token="$(printf '%s' "$research_token_b64" | base64 -d)"
unset chat_token_b64 research_token_b64

tmp_dir="$(mktemp -d)"
case "$tmp_dir" in
    /tmp/*) ;;
    *) echo "error=unexpected_temp_path" >&2; exit 1 ;;
esac
chmod 700 "$tmp_dir"
cleanup() {
    rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

chat_header="$tmp_dir/chat.headers"
research_header="$tmp_dir/research.headers"
printf 'Authorization: Bearer %s\n' "$chat_token" > "$chat_header"
printf 'Authorization: Bearer %s\n' "$research_token" > "$research_header"
chmod 600 "$chat_header" "$research_header"
unset chat_token research_token

resolve=(--resolve "${host}:443:${edge_ip}")

http_redirect="$(
    curl -sS -o /dev/null \
        --connect-timeout 8 --max-time 20 \
        --resolve "${host}:80:${edge_ip}" \
        -w '%{http_code}|%{redirect_url}' \
        "http://${host}/gateway/health"
)"
if [ "$http_redirect" != "301|https://${host}/gateway/health" ]; then
    echo "error=http_redirect value=$http_redirect" >&2
    exit 1
fi
echo "http_redirect=ok"

health_status="$(
    curl -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 20 \
        -D "$tmp_dir/health.headers" -o "$tmp_dir/health.json" \
        -w '%{http_code}' \
        "$base_url/gateway/health"
)"
if [ "$health_status" != "200" ] ||
   ! jq -e '.state == "ready" and .phase == "r760-loopback"' "$tmp_dir/health.json" >/dev/null; then
    echo "error=health status=$health_status" >&2
    exit 1
fi
echo "health=ok phase=r760-loopback"

unauth_models_status="$(
    curl -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 20 \
        -o /dev/null -w '%{http_code}' \
        "$base_url/v1/models"
)"
if [ "$unauth_models_status" != "401" ]; then
    echo "error=unauthenticated_models status=$unauth_models_status" >&2
    exit 1
fi
echo "unauthenticated_models=401"

credential_status="$(
    curl -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 30 \
        --header @"$chat_header" \
        -D "$tmp_dir/credential.headers" -o "$tmp_dir/credential.json" \
        -w '%{http_code}' \
        "$base_url/gateway/credentials/current"
)"
if [ "$credential_status" != "200" ]; then
    echo "error=credential_self_check status=$credential_status" >&2
    exit 1
fi
echo "credential_self_check=ok"

models_status="$(
    curl -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 30 \
        --header @"$chat_header" \
        -D "$tmp_dir/models.headers" -o "$tmp_dir/models.json" \
        -w '%{http_code}' \
        "$base_url/v1/models"
)"
if [ "$models_status" != "200" ] ||
   ! jq -e '([.data[].id] | sort) == ["goldencode"]' "$tmp_dir/models.json" >/dev/null; then
    echo "error=model_surface status=$models_status" >&2
    exit 1
fi
echo "model_surface=goldencode"

chat_status="$(
    curl -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 180 \
        --header @"$chat_header" \
        -H 'Content-Type: application/json' \
        -D "$tmp_dir/chat.headers.out" -o "$tmp_dir/chat.json" \
        -w '%{http_code}' \
        --data '{"model":"goldencode","messages":[{"role":"user","content":"Reply with exactly CN1-EDGE-OK"}],"temperature":0,"max_tokens":64,"stream":false}' \
        "$base_url/v1/chat/completions"
)"
if [ "$chat_status" != "200" ] ||
   ! jq -e '(.choices[0].message.content | type == "string" and length > 0) and (.usage.total_tokens > 0)' "$tmp_dir/chat.json" >/dev/null; then
    echo "error=nonstream_chat status=$chat_status" >&2
    exit 1
fi
chat_request_id="$(awk 'tolower($1) == "x-request-id:" {gsub("\\r", "", $2); print $2}' "$tmp_dir/chat.headers.out" | tail -n 1)"
if [ -z "$chat_request_id" ]; then
    echo "error=nonstream_missing_request_id" >&2
    exit 1
fi
echo "nonstream_chat=ok request_id=$chat_request_id"

stream_status="$(
    curl -N -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 180 \
        --header @"$chat_header" \
        -H 'Content-Type: application/json' \
        -D "$tmp_dir/stream.headers" -o "$tmp_dir/stream.sse" \
        -w '%{http_code}' \
        --data '{"model":"goldencode","messages":[{"role":"user","content":"Reply with exactly CN1-SSE-OK"}],"temperature":0,"max_tokens":64,"stream":true}' \
        "$base_url/v1/chat/completions"
)"
if [ "$stream_status" != "200" ] ||
   ! grep -q '^data:' "$tmp_dir/stream.sse" ||
   ! grep -q '\[DONE\]' "$tmp_dir/stream.sse"; then
    echo "error=stream_chat status=$stream_status" >&2
    exit 1
fi
echo "stream_chat=ok"

set +e
curl -N -sS "${resolve[@]}" \
    --connect-timeout 8 --max-time 1 \
    --header @"$chat_header" \
    -H 'Content-Type: application/json' \
    -o /dev/null \
    --data '{"model":"goldencode","messages":[{"role":"user","content":"Write a detailed 1500-word explanation of distributed systems reliability."}],"max_tokens":2048,"stream":true}' \
    "$base_url/v1/chat/completions" 2>/dev/null
cancel_rc=$?
set -e
if [ "$cancel_rc" -ne 0 ] && [ "$cancel_rc" -ne 28 ]; then
    echo "error=client_cancel rc=$cancel_rc" >&2
    exit 1
fi
post_cancel_status="$(
    curl -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 20 \
        -o /dev/null -w '%{http_code}' \
        "$base_url/gateway/health"
)"
if [ "$post_cancel_status" != "200" ]; then
    echo "error=post_cancel_health status=$post_cancel_status" >&2
    exit 1
fi
echo "client_cancel=ok rc=$cancel_rc post_health=200"

research_status="$(
    curl -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 60 \
        --header @"$research_header" \
        -D "$tmp_dir/research.headers.out" -o "$tmp_dir/research.json" \
        -w '%{http_code}' \
        "$base_url/gateway/research/v1/doctor-runs?limit=10"
)"
if [ "$research_status" != "200" ] ||
   ! jq -e '.schema_version == "doctor_research_run_list.v1" and (.items | type == "array")' "$tmp_dir/research.json" >/dev/null; then
    echo "error=research_list status=$research_status" >&2
    exit 1
fi
research_count="$(jq '.items | length' "$tmp_dir/research.json")"
echo "research_list=ok item_count=$research_count"

succeeded_run="$(jq -r '[.items[] | select(.status == "succeeded")][0].run_id // empty' "$tmp_dir/research.json")"
if [ -n "$succeeded_run" ]; then
    result_status="$(
        curl -sS "${resolve[@]}" \
            --connect-timeout 8 --max-time 60 \
            --header @"$research_header" \
            -o "$tmp_dir/research-result.json" -w '%{http_code}' \
            "$base_url/gateway/research/v1/doctor-runs/$succeeded_run/result"
    )"
    if [ "$result_status" != "200" ] ||
       ! jq -e '.schema_version == "doctor_research_result.v1" and (.artifacts | length == 4)' "$tmp_dir/research-result.json" >/dev/null; then
        echo "error=research_result status=$result_status" >&2
        exit 1
    fi
    echo "research_existing_result=ok artifacts=4"

    artifact_url="$(jq -r '.artifacts[0].download_url' "$tmp_dir/research-result.json")"
    artifact_size="$(jq -r '.artifacts[0].size_bytes' "$tmp_dir/research-result.json")"
    artifact_sha256="$(jq -r '.artifacts[0].sha256' "$tmp_dir/research-result.json")"
    case "$artifact_url" in
        /gateway/research/v1/artifacts/*/download) ;;
        *) echo "error=research_artifact_url" >&2; exit 1 ;;
    esac
    artifact_status="$(
        curl -sS "${resolve[@]}" \
            --connect-timeout 8 --max-time 120 \
            --header @"$research_header" \
            -o "$tmp_dir/research-artifact" -w '%{http_code}' \
            "$base_url$artifact_url"
    )"
    actual_size="$(stat -c '%s' "$tmp_dir/research-artifact")"
    actual_sha256="$(sha256sum "$tmp_dir/research-artifact" | awk '{print $1}')"
    if [ "$artifact_status" != "200" ] ||
       [ "$actual_size" != "$artifact_size" ] ||
       [ "$actual_sha256" != "$artifact_sha256" ]; then
        echo "error=research_artifact status=$artifact_status size_match=$([ "$actual_size" = "$artifact_size" ] && echo yes || echo no) hash_match=$([ "$actual_sha256" = "$artifact_sha256" ] && echo yes || echo no)" >&2
        exit 1
    fi
    echo "research_artifact=ok size=$actual_size sha256_match=yes"
else
    echo "research_existing_result=not_available"
fi

image_status="$(
    curl -sS "${resolve[@]}" \
        --connect-timeout 8 --max-time 300 \
        --header @"$chat_header" \
        -H 'Content-Type: application/json' \
        -D "$tmp_dir/image.headers.out" -o "$tmp_dir/image.json" \
        -w '%{http_code}' \
        --data '{"model":"medcode-image-default","prompt":"A minimal blue medical cross icon centered on a plain white background, flat vector style.","size":"1024x1024","quality":"low","output_format":"jpeg","metadata":{"client":"cn1-edge-dark-smoke"}}' \
        "$base_url/gateway/images/generations"
)"
if [ "$image_status" != "200" ] ||
   ! jq -e '(.id | startswith("imgreq_")) and (.data[0].b64_json | length > 100) and (.data[0].mime_type == "image/jpeg")' "$tmp_dir/image.json" >/dev/null; then
    error_code="$(jq -r '.error.code // "unknown"' "$tmp_dir/image.json" 2>/dev/null || printf 'unparseable')"
    echo "error=image_generation status=$image_status code=$error_code" >&2
    exit 1
fi
image_b64_bytes="$(jq -r '.data[0].b64_json | length' "$tmp_dir/image.json")"
image_request_id="$(awk 'tolower($1) == "x-request-id:" {gsub("\\r", "", $2); print $2}' "$tmp_dir/image.headers.out" | tail -n 1)"
echo "image_generation=ok b64_length=$image_b64_bytes request_id=$image_request_id"

echo "cn1_edge_dark_smoke=ok"
