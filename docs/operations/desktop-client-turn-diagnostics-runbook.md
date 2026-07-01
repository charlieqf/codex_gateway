# Desktop Client Turn Diagnostics Runbook

Use the admin CLI `client-turn` command to join Desktop diagnostic uploads with
Gateway model request observations by `turn_code` or `client_turn_id`.

Production container example:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  --client-events-db /var/lib/codex-gateway/client-events.db \
  client-turn T:7K3P2 \
  --at "2026-07-01 16:07" \
  --window-minutes 15 \
  --timezone Asia/Shanghai
```

Output includes:

- `client_diagnostics`: matching `client_diagnostic_events`, including
  `metadata.client_turn_id`, `metadata.turn_code`, and
  `metadata.gateway_request_id` when present.
- `gateway_requests`: matching `request_events`, including public model id,
  resolved upstream model, reasoning effort, tool choice, upstream HTTP status,
  finish reason, content chars, tool call count/names, raw response hash/chars,
  `upstream_empty_stop`, `upstream_attempt_count`, and `upstream_attempts`.
  `upstream_attempts` is internal JSON with one entry per upstream attempt,
  including retry kind, tool choice, runtime/model/account attribution, finish
  reason, status/error code, content chars, tool call summary, raw response
  hash/chars, and empty-stop classification.
- `timeline`: merged chronological view of the client diagnostics and Gateway
  model request rows.

Notes:

- `--at` accepts ISO datetimes with an explicit offset, or
  `YYYY-MM-DD HH:mm` interpreted in `--timezone`.
- The command opens both SQLite files read-only and does not run migrations.
- Diagnostic metadata preserves unknown fields and accepts P0 summary objects
  such as `request_shape`, `stream_terminal`, and `tool_schema_validation`.
  Gateway still rejects credential/secret material recursively; these objects
  must contain shapes and counts, not raw prompts, raw bodies, API keys, bearer
  tokens, or cookies.
- Normal user UI/support blocks must not include resolved upstream model,
  reasoning effort, raw prompt, raw tool args, API keys, or credentials.
