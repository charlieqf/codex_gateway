# Codex GoldenCode External Access

Last updated: 2026-08-31.

External Codex users use the authoritative R760 OpenAI-compatible base:

```text
https://goldencode.instmarket.com.au:1443/v1
```

Use the cloud model `goldencode` for this Codex configuration. The separate
`goldencode-local` Desktop route has a 32,768-token admission limit and is not
the default external Codex profile described here.

## Codex Configuration

Add this provider to the user's Codex `config.toml`:

```toml
model = "goldencode"
model_provider = "medevidence_goldencode"
model_reasoning_effort = "medium"

[model_providers.medevidence_goldencode]
name = "MedEvidence GoldenCode"
base_url = "https://goldencode.instmarket.com.au:1443/v1"
env_key = "GOLDENCODE_API_KEY"
wire_api = "responses"
```

Set the issued unified key in the process environment before starting Codex:

```powershell
$env:GOLDENCODE_API_KEY = "cgu_live_<user-key>"
```

Never paste the real key into repository files, screenshots, tickets, logs or
shared chat. Restart Codex after changing `config.toml` or its environment.

## Contract

- A valid `cgu_live_*` key authenticates directly on Gateway business routes.
- User/key state, entitlement, rate limits and token accounting still apply.
- The Responses adapter supports text, streaming, function calls, function
  results and subsequent turns.
- Capture `X-Request-Id` for support investigations.

For a real-user key, follow
[MedEvidence Codex Key Provisioning](./medevidence-codex-key-provisioning.md).
For current model/runtime status, see [System Status](./system-status.md).
