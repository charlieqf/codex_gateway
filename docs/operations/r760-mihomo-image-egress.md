# R760 Mihomo Image Egress

Last updated: 2026-08-06

This runbook covers the dedicated R760 image-egress proxy. It is infrastructure
for the public Gateway, not a fifth Doctor Research business service and not a
replacement for CN1's separate loopback GoldenCode Gateway.

## Current topology

```text
R760 public Gateway
  -> HTTP_PROXY / HTTPS_PROXY = http://mihomo:7890
  -> codex_gateway_r760_default private Docker network
  -> codex_gateway_r760-mihomo-1
  -> overseas image APIs

Tencent GLM-5.2 and internal/domestic endpoints
  -> exact NO_PROXY match
  -> direct connection, never Mihomo

Private Cloudflare R2 vision asset endpoint
  -> exact NO_PROXY match plus explicit direct HTTPS storage transport
  -> direct connection, never Mihomo
```

The Mihomo container publishes no host port. Do not add `ports`, bind host
`7890/7891/9090`, or expose a controller. The public Gateway is the only
application container with proxy variables. `research-llm-gateway`,
`research-worker` and `research-maintenance` must keep `HTTP_PROXY` and
`HTTPS_PROXY` empty.

## Installed boundary

```text
root:       /opt/codex-gateway-r760/infrastructure/mihomo
compose:    /opt/codex-gateway-r760/infrastructure/mihomo/compose.yml
container:  codex_gateway_r760-mihomo-1
project:    codex_gateway_r760_mihomo
network:    codex_gateway_r760_default (external)
version:    Mihomo Meta v1.19.23, linux amd64
```

The binary SHA-256 is
`ebac72f8a866ebb599ba451d6516fe3f7ae9075c3b9de1ed2be5a6dd706e9c6e`.
The R760-derived config SHA-256 is
`59901802e7be8e502e15f0e7f6f672c352ffbf0f209cc56447612f2ddf4c451f`.
Do not print or commit the config: it contains 32 embedded proxy nodes and their
credentials. There is no online `proxy-provider`, so the installed snapshot
does not auto-refresh a subscription.

Host metadata is intentionally restrictive:

- config: UID/GID `999:999`, mode `0400`;
- binary: `root:999`, mode `0550`;
- state directory: UID/GID `999:999`, mode `0700`;
- current `cache.db` and `geoip.metadb`: UID/GID `999:999`, mode `0600`;
- Compose and manifests: `root:root`, mode `0600`;
- container: UID/GID `999:999`, read-only root filesystem, all capabilities
  dropped, `no-new-privileges`, bounded memory/PIDs/logs and
  `restart: unless-stopped`.

The active R760 config deliberately removes CN1's external controller and SOCKS
listener. CN1 currently shows a wildcard `:7890` listener; that exposure shape
was not copied.

Use `static-manifest.sha256` for ongoing integrity checks. It covers only the
Mihomo binary and R760-derived config. `cache.db` and `geoip.metadb` are mutable
runtime state: Mihomo can update them after startup, so their transfer-time
hashes are provenance records, not a steady-state integrity invariant. Mihomo
v1.19.23 reports process umask `0022`; the state directory's `0700` mode is the
durable access boundary. Verify that the two existing state files remain `0600`
after upgrades or state replacement.

## Safe status checks

Run on R760 without printing config or environment values:

```bash
cd /opt/codex-gateway-r760/infrastructure/mihomo
sha256sum -c static-manifest.sha256
docker compose -f compose.yml ps
docker inspect codex_gateway_r760-mihomo-1 \
  --format 'state={{.State.Status}} health={{.State.Health.Status}} restart={{.RestartCount}} ports={{json .HostConfig.PortBindings}}'
stat -c '%n %u:%g %a' state state/cache.db state/geoip.metadb
ss -ltn '( sport = :7890 or sport = :7891 or sport = :9090 )'
docker port codex_gateway_r760-mihomo-1
curl -fsS http://127.0.0.1:18787/gateway/health >/dev/null
```

Expected results are `running/healthy`, empty port bindings, no host listeners
on `7890/7891/9090`, and a healthy public Gateway. Do not use `docker logs`
without sanitization because proxy failures may include node or destination
details.

## Start, stop and self-healing

```bash
cd /opt/codex-gateway-r760/infrastructure/mihomo
docker compose -f compose.yml up -d --no-build
docker compose -f compose.yml stop mihomo
```

After a start, wait for container health before accepting image tests. The
2026-08-04 drill killed only this container's exact host PID and verified that
Docker restarted it healthy with an incremented restart count. This does not
replace a future full-host cold-boot drill.

## Gateway proxy scope

The protected Gateway env file contains these setting names:

```text
NODE_USE_ENV_PROXY
HTTP_PROXY
HTTPS_PROXY
NO_PROXY
```

Never print that env file. Validate only that the running public Gateway has the
expected proxy URL and that `NO_PROXY` includes Tencent TokenHub, the domestic
Gateway v2 upstream, the exact private R2 account hostname, loopback, Docker
service names and the metadata address. R2's authenticated verification and
cleanup requests also use a dedicated direct HTTPS transport so model-egress
proxy initialization cannot affect private object visibility.
The 2026-08-04 fault injection stopped Mihomo and sent a real `goldencode`
request; it still succeeded as
`goldencode-tencent / tencent / glm-5.2`, proving Tencent bypass.

## Validation state

Passed on 2026-08-04:

- OpenAI no-key probe returned 401 through R760 Mihomo;
- xAI no-key probe returned 401 and a real
  `grok-imagine-image-quality` request produced a valid JPEG;
- the public Gateway `medcode-image-default -> gpt-image-1.5` route produced a
  valid JPEG through the SNI origin;
- Gateway commit `43e118eb00083ee44164329568a62941169ee78c` was deployed and
  a fresh real request produced a 46,085-byte JPEG. Request event
  `req-72502774-9ad4-4b49-a797-ef50c43c289e` records
  `provider=openai-api`, `public_model_id=medcode-image-default`,
  `upstream_model=gpt-image-1.5` and `status=ok`. The paired text control event
  records `tencent / goldencode / glm-5.2`;
- temporary users, API keys and entitlements were cleaned, with zero unfinished
  reservations;
- all four business containers stayed healthy and only the public Gateway was
  recreated.

Passed on 2026-08-08 for URL-only vision input:

- Gateway release `abb137325bfddda7cb5621bbffb202a040f5bd12` completed private
  R2 create, presigned PUT, full-body SHA-256 validation, read-URL refresh,
  overwrite rejection and deletion through the public R760 endpoint;
- Chat Completions and Responses API both passed an initial chart question and
  a follow-up after refreshing the signed URL and replaying the original image;
- four vision events record `xai / goldencode / grok-4.5`, while the paired
  text control records `tencent / goldencode / glm-5.2`;
- temporary credentials and unfinished reservations are zero, the R2 test
  bucket audit is empty, and Gateway, Research and Mihomo are healthy with zero
  restarts.

Still open:

- Gemini returns Google `FAILED_PRECONDITION` because the proxy exit location is
  unsupported. All 21 currently alive copied leaf nodes returned the same
  result while OpenAI/xAI remained reachable. Add a dedicated supported-region
  node, then repeat a real `gemini-3.1-flash-image` smoke.

The provider/model observability gate is therefore closed for the deployed
OpenAI path. Automated tests also cover xAI and Gemini attribution across
primary, account-retry and billing-fallback attempts; their real event fields
must still be checked whenever those providers become the selected runtime
path.

The temporary selector controller used for diagnosis was bound only to the
container loopback, then removed. The installed config and cache were restored
to their pre-probe hashes before the production restart; subsequent cache and
GeoIP changes are normal runtime state and are not part of the static manifest.

## Rollback

The pre-change protected Gateway files are under:

```text
/data/codex-gateway-r760/backups/pre-mihomo-20260804T034553Z
```

To roll back, first verify the exact backup and target paths, restore only
`gateway.container.env`, run the full R760 Compose `config --quiet`, and
force-recreate only `gateway` with the base file, Research overlay, private
Compose env and R760 override. Then stop the exact Mihomo service. Preserve the
Mihomo directory and logs for diagnosis; do not delete the application volumes,
four business containers, releases or image rollback tags.

The later selector-probe rollback boundary is:

```text
/data/codex-gateway-r760/backups/pre-gemini-egress-probe-20260804T041837Z
```

It contains only the restricted pre-probe Mihomo config/cache and manifest.

The final state-permission adjustment boundary is:

```text
/data/codex-gateway-r760/backups/pre-mihomo-state-umask-20260804T043007Z
```

It contains the pre-adjustment Compose file and state metadata. The active
state files were tightened to `0600`; no application volume was changed.

The Gateway attribution deployment boundary is:

```text
/data/codex-gateway-r760/backups/pre-image-attribution-20260804T064424Z
```

Its three online SQLite backups pass their SHA-256 manifest, integrity and
foreign-key checks. At that deployment, `previous` pointed to release
`4697fba`; Gateway image tag `rollback-4697fba-pre-43e118e` is retained. Roll
back only the public Gateway, not Mihomo or the three Research services.

The later long-output P0 shadow deployment boundary is:

```text
/data/codex-gateway-r760/backups/pre-long-output-p0-20260806T033029Z
```

Its online backups of `gateway.db`, `client-events.db` and `research.db` pass
their SHA-256 manifest, integrity and foreign-key checks. At that deployment,
`current` was release `9ba088508d1df2de30441adb4814409b1d757bc8`, `previous` was `43e118e`, and
Gateway image tag `rollback-43e118e-pre-9ba0885` is retained. The effective
long-output recovery mode is `shadow` and active chunk remains 0%. Roll back
only the public Gateway to `43e118e`; do not recreate Mihomo or any Research
service.

The URL-only vision release boundaries are:

```text
/data/codex-gateway-r760/backups/pre-abb137325bfd-20260808T094843Z
/data/codex-gateway-r760/backups/pre-8d3ff289126e-20260808T093934Z
/data/codex-gateway-r760/backups/pre-r2-no-proxy-20260808T092757Z
```

The active release is `abb137325bfddda7cb5621bbffb202a040f5bd12`; `previous`
is `8d3ff289126e8742f0199c19334434a08e3c8d6b`. The first boundary is the
preferred code rollback point. Restore the protected env only if also rolling
back the R2 route, run Compose validation, then force-recreate only Gateway.
Do not recreate Mihomo or any Research container.
