# Codex App GoldenCode External Access

External Codex users can use the same OpenAI-compatible base URL as the
MedEvidence/GoldenCode Desktop client:

```text
https://gw.instmarket.com.au/v1
```

The Desktop client continues to call `POST /v1/chat/completions`. Codex uses
`POST /v1/responses`; both routes coexist under the same `/v1` base URL.

## Codex configuration

Add the following to the user's Codex `config.toml`:

```toml
model = "goldencode"
model_provider = "medevidence_goldencode"
model_reasoning_effort = "medium"

[model_providers.medevidence_goldencode]
name = "MedEvidence GoldenCode"
base_url = "https://gw.instmarket.com.au/v1"
env_key = "GOLDENCODE_API_KEY"
wire_api = "responses"
```

Set the API key in the user's environment before starting Codex:

```powershell
$env:GOLDENCODE_API_KEY = "cgu_live_<user-key>"
```

Do not paste a real `cgu_live_*` key into repository files, screenshots,
tickets, logs, or shared chat. Restart Codex after changing `config.toml` or
the environment variable.

## Routing behavior

`model = "goldencode"` selects the four-member GoldenCode pool:

- `goldencode-qianfan` -> Qianfan `glm-5.2`
- `goldencode-tencent` -> Tencent `glm-5.2`
- `goldencode-aliyun` -> Aliyun `glm-5.2`
- `goldencode-openrouter` -> OpenRouter `z-ai/glm-5.2`

The pool uses deterministic HRW selection. Requests in one Codex conversation
stay on the same member through the Responses `prompt_cache_key`; different
conversations distribute across the four members. All members use reasoning
effort `medium`.

## Authentication and compatibility

- A valid `cgu_live_*` key authenticates directly on Gateway business routes;
  Codex does not need to call `/gateway/unified-keys/resolve` first.
- Unified-key expiry/revocation, backing Gateway-key expiry/revocation, disabled
  users, rate limits, entitlements, token accounting, and request observations
  still apply.
- The Responses adapter supports text output, streaming events, Codex function
  tools, function-call results, and subsequent turns.
- `/v1/responses` intentionally accepts only `model = "goldencode"` for this
  external Codex surface.

## Release verification

Use `scripts/smoke-codex-responses-public.mjs` with a temporary handoff JSON.
The script reads the full key only from the local file, runs a real Codex CLI
tool-call/follow-up flow, prints only the safe key prefix, and removes its
temporary Codex home. Revoke the temporary unified key and backing Gateway key,
disable the smoke user, and remove the handoff JSON after the run.
