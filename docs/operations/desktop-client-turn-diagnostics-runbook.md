# Desktop Client Turn Diagnostics

Last updated: 2026-08-31.

Use this only when a normal user/time-window message query is insufficient and
a Desktop `turn_code`, `client_turn_id` or support code is available.

## R760 Query

Run from an R760 SSH session:

```bash
docker exec codex_gateway_r760-gateway-1 \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  --client-events-db /var/lib/codex-gateway/client-events.db \
  client-turn T:7K3P2 \
  --at "2026-08-31 14:00" \
  --window-minutes 15 \
  --timezone Asia/Shanghai
```

The command opens both SQLite databases read-only and returns:

- matching client diagnostic events;
- correlated Gateway request events and upstream attempts;
- a merged timeline.

`--at` accepts an ISO time with offset or a local
`YYYY-MM-DD HH:mm` interpreted using `--timezone`.

## Privacy

Return only the target user's necessary timeline, IDs, statuses and sanitized
diagnostics. Do not include phone numbers, credentials, raw prompts, raw tool
arguments, provider bodies, cookies or tokens in ordinary support output.

If the timeline shows Gateway success but the artifact or UI failed, classify
the issue on the Desktop/tool-loop side. Do not infer Gateway failure from the
visible client outcome alone.
