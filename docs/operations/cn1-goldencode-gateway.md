# CN1 GoldenCode Gateway

Last updated: 2026-08-04

This runbook records the CN1-only Codex Gateway profile on the Aliyun CN1 VM.
It is deliberately different from the Azure `gw.instmarket.com.au` gateway.

## Current State

- Deployment host: Aliyun CN1 VM. Use operator-local skill/access notes for SSH
  details; do not commit SSH credentials or provider keys.
- App root: `/opt/codex-gateway-cn1`
- Current release symlink: `/opt/codex-gateway-cn1/current`
- Compose file: `/opt/codex-gateway-cn1/current/compose.azure.yml`
- Compose project: `codex_gateway_cn1`
- Container: `codex_gateway_cn1-gateway-1`
- Container image tag: `codex_gateway_cn1-gateway:latest`
- Runtime env file: `/opt/codex-gateway-cn1/current/config/gateway.container.env`
- Provider-key backup copy: `/opt/codex-gateway-cn1/secrets/provider.env`
- Docker volumes:
  - `codex_gateway_cn1_gateway_state`
  - `codex_gateway_cn1_gateway_logs`
- Listener: `127.0.0.1:18787->8787`
- Loopback Gateway public routing: none. The CN1 loopback container remains
  private and is not used by the edge route.
- R760 edge role: the dedicated `https://gw.instmarket.com.au:443` CN1 Nginx
  vhost and independent certificate are installed and enabled. It proxies to
  the R760 origin at `https://goldencode.instmarket.com.au:1443`, but remains a
  dark route because public `gw` DNS still points to Azure.

The approved edge role does not expose this loopback container. A request for
`gw.instmarket.com.au` must go to R760, never to CN1
`127.0.0.1:18787`.

## Model Profile

CN1 is a domestic-only, GLM-5.2-only gateway. `/v1/models` should expose only:

```text
goldencode
```

Because the Aliyun and Qianfan subscriptions are temporarily cancelled,
`goldencode` currently has exactly one enabled member:

| member | runtime | upstream model |
| --- | --- | --- |
| `goldencode-tencent` | `tencent` | `glm-5.2` |

The previous three-member env is backed up at
`/opt/codex-gateway-cn1/backups/tencent-only-20260804T0305Z`. The Gateway was
recreated healthy with zero restarts, and smoke request
`req-cb134460-c360-4dd5-93c4-e5cbc94d26ed` succeeded through
`goldencode-tencent / tencent / glm-5.2`. Do not re-enable Qianfan or Aliyun
until their subscriptions and the routing decision are explicitly restored.

OpenRouter is intentionally absent from the CN1 profile. Do not add
`MEDCODE_OPENROUTER_*` env vars or an OpenRouter pool member to CN1 unless the
CN-only policy is deliberately changed.

Important env shape:

```text
MEDCODE_PUBLIC_MODEL_ID=goldencode
MEDCODE_IMAGE_GENERATION_ENABLED=0
GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL=1
GATEWAY_PUBLIC_PHASE=cn1-loopback
```

`GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL=1` is intentional for CN1 because this
profile does not expose Codex/OpenAI subscription-backed models. The service
still uses credential auth and SQLite state.

## Approved CN1 Edge Role (Enabled, DNS Not Cut Over)

The domestic production destination is R760, not CN1. R760 will run the public
Gateway plus the isolated Research LLM Gateway, Worker and maintenance
containers. CN1 is only the public SNI/TLS reverse-proxy edge required because
the network administrator declined public `443 -> R760:443`.

Target request path:

```text
client https://gw.instmarket.com.au:443
  -> CN1 Nginx, server_name gw.instmarket.com.au
  -> HTTPS origin with SNI goldencode.instmarket.com.au:1443
  -> R760 Nginx
  -> R760 127.0.0.1:18787
  -> codex_gateway_r760 gateway
```

Consequences:

- client base URLs remain `https://gw.instmarket.com.au`; no explicit port
  change is required;
- R760 must set
  `GATEWAY_PUBLIC_BASE_URL=https://gw.instmarket.com.au` even though its origin
  SNI name is `goldencode.instmarket.com.au`;
- `goldencode.instmarket.com.au:1443` is an origin/staging identity, not the
  advertised client endpoint;
- CN1 terminates the `gw` certificate and validates a second TLS connection to
  the R760 `goldencode` certificate;
- CN1's existing `codex_gateway_cn1` service and state volumes remain isolated
  and do not receive production traffic; its loopback pool is now
  Tencent-only;
- Azure is retained only as a short cutover rollback boundary and is not a
  permanent proxy. After it is retired, CN1 is the public single point.

The R760 public text-model surface is exactly `goldencode`, backed only by
direct Tencent GLM-5.2. The other seven Azure text model ids
and OpenRouter do not migrate. Image generation is a separate API capability:
R760 retains `medcode-image-default` through `gpt-image-1.5`,
`grok-imagine-image-quality`, and `gemini-3.1-flash-image`, with no
`gpt-image-2`. CN1 only transports those image requests and responses.

“Domestic-only” constrains LLM providers, not the controlled SerpAPI, PubMed,
Crossref, ORCID or official-site retrieval used by Doctor Research, and not the
separately governed image-provider chain.

### Installed edge configuration and 2026-08-04 dark smoke

The explicitly approved maintenance action installed:

- version-controlled vhost source:
  `ops/nginx/cn1-gw-r760-edge.conf`;
- CN1 active file:
  `/etc/nginx/sites-available/gw.instmarket.com.au.conf`, with only its matching
  symlink in `sites-enabled`;
- upstream pinned to `117.186.49.26:1443`, with verified origin Host/SNI
  `goldencode.instmarket.com.au`;
- client-facing certificate under
  `/etc/letsencrypt/live/gw.instmarket.com.au`, valid until 2026-11-02;
- Cloudflare DNS-01 credentials at
  `/etc/letsencrypt/cloudflare-instmarket.ini`, owned by `root:root` with mode
  `0600`. Never print or copy this file into Git;
- deploy hook `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx`, which runs
  `nginx -t` before reloading;
- pre-change backup
  `/opt/codex-gateway-cn1/backups/pre-gw-edge-20260804T182835+1000`.

Cloudflare token verification, Let's Encrypt staging issuance, production
issuance and `certbot renew --dry-run --cert-name gw.instmarket.com.au` all
succeeded. The deploy hook was separately executed successfully because
Certbot intentionally skips deploy hooks during an ordinary dry-run.

The version-controlled `ops/smoke/cn1-edge-dark-smoke.sh` accepts test keys only
through standard input and stores temporary auth headers in a mode-0600 file.
From an independent Aliyun VM, an explicit `gw -> 47.116.7.37` resolution
passed:

- HTTP-to-HTTPS redirect and client-certificate verification;
- health with `state=ready` and `phase=r760-loopback`, proving the request did
  not enter CN1 `127.0.0.1:18787`;
- unauthenticated `401`, opaque credential self-check and exact one-model
  surface `goldencode`;
- non-stream chat, SSE and a one-second client disconnect followed by healthy
  recovery;
- Doctor Research list, an existing four-artifact result, and an authenticated
  artifact download whose byte size and SHA-256 matched its manifest;
- low-quality `medcode-image-default` generation. Representative text/image
  request ids were `req-82bd95c3-2d9c-4925-8a51-d8359884e365` and
  `req-c7309ed6-6597-40ca-9617-59c630f44a26`.

This is not yet public cutover approval. A forced CN1 address from the Sydney
operator workstation returned `403 Server: Beaver` with
`Non-compliance ICP Filing` on HTTP. HTTPS for `gw`, the existing
`medevidence` name and the existing `nip.io` name was reset before Nginx; an
Azure-to-CN1 HTTPS check was also reset. These requests produced no Nginx
access entry. The upstream Aliyun public-ingress/filing boundary must be
resolved and revalidated from independent public client networks before DNS is
changed.

### Read-only capacity and latency baseline

The 2026-08-03 baseline found:

- Nginx active/enabled on public `80/443`, with its current configuration test
  passing;
- Certbot installed with an active renewal timer;
- approximately 80 GiB free on the 99 GiB root filesystem;
- approximately 13 GiB available from 14 GiB RAM and low current load;
- successful TLS/SNI validation from CN1 to the R760 `:1443` origin. The
  2026-08-03 baseline returned the expected `502` while the formal R760 Gateway
  was stopped; after the 2026-08-04 loopback deployment the same origin health
  returns 200 with an explicit address override. The `goldencode` origin still
  does not have ordinary public A-record resolution.

Thirty fresh CN1-to-R760 HTTPS connections measured:

| phase | p50 | p95 |
| --- | ---: | ---: |
| TCP connect | 10.09 ms | 10.89 ms |
| TCP + TLS | 26.22 ms | 26.89 ms |
| complete immediate response | 43.81 ms | 45.54 ms |

These are cold-connection network/TLS measurements, not application latency.
With upstream keepalive and TLS session reuse, steady-state overhead should be
primarily the roughly 10 ms CN1-R760 round trip. That is small for LLM and
asynchronous Research requests, but image/artifact transfer throughput must be
tested because all bytes traverse CN1.

### Edge vhost requirements

The installed dedicated CN1 vhost does not change existing/default vhosts and
implements the following contract:

- match only `gw.instmarket.com.au` and present a valid independently renewed
  certificate;
- proxy to the R760 public NAT `:1443` while setting
  `proxy_ssl_server_name on` and validating
  `proxy_ssl_name goldencode.instmarket.com.au`;
- either pin the validated R760 NAT address in the upstream or add a DNS-only
  `goldencode` origin record; do not assume the currently absent public lookup
  will begin working, and do not put this long-request origin behind an
  unvalidated CDN proxy;
- use HTTP/1.1 upstream keepalive, an empty upstream `Connection` header and TLS
  session reuse;
- disable request/response buffering and caching for SSE and long model calls;
- set read/send/connect timeouts consistent with Gateway and Doctor Research
  hard limits;
- preserve request ids and a trustworthy `X-Forwarded-For` /
  `X-Forwarded-Proto` chain while sending the R760 origin the expected Host/SNI;
- support authenticated image and artifact payload sizes without buffering
  them to the CN1 root disk;
- expose an HTTPS health monitor covering both the CN1 vhost and the R760
  Gateway, not ICMP ping;
- use DNS-only routing for `gw` unless a separately validated CDN plan supports
  the required long-request timeout;
- after smoke, restrict R760 `:1443` to CN1 and approved operator sources.

Before DNS cutover, retain the explicit-resolution smoke and repeat it from
independent public networks after the filing/ingress block is resolved. The
2026-08-04 smoke covered health, credential self-check, the exact one-model
surface, non-stream chat, SSE, client cancellation, Doctor Research
list/result/download and the default retained image path. A new Research create
and each non-default image fallback remain part of the final maintenance-window
smoke. Rollback is a DNS return to Azure only during the temporary observation
period.

### Edge rollback

Before DNS cutover, disabling the dark route has no client impact. During the
temporary post-cutover observation period, return `gw` DNS to Azure first and
wait for the approved TTL boundary, then disable the CN1 file:

```bash
rm -f /etc/nginx/sites-enabled/gw.instmarket.com.au.conf
nginx -t
systemctl reload nginx
```

Do not delete the certificate, Cloudflare credential, backup or
`sites-available` source during rollback. Re-enabling is the inverse symlink
operation followed by `nginx -t` and reload. The backup archive is for
configuration recovery, not a reason to overwrite unrelated current Nginx
sites.

See
`../implementation/domestic-gateway-doctor-research-migration-plan-2026-07-30.zh-CN.md`
for the destination data, credential, validation and cutover gates.

## Safety Rules

- Do not modify CN1 Nginx, public ports `80/443`, MedEvidence services, or
  firewall rules while operating the loopback Gateway. The edge is installed;
  any further edge mutation still requires a separate explicit maintenance
  action.
- Do not run `docker compose down` unless the project name is explicit and the
  volume impact is understood.
- Do not print `config/gateway.container.env`, provider keys, admin bearer
  tokens, or full user API keys.
- Do not copy Azure's full 8-model env onto CN1. Azure and CN1 are separate
  deployment profiles.
- The new `gw` server block must proxy to R760, not to this service's
  `http://127.0.0.1:18787`, and must not reuse an existing MedEvidence hostname
  or default server block.

## Basic Checks

Run these on CN1:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml ps
curl -fsS http://127.0.0.1:18787/gateway/health
ss -ltnp '( sport = :18787 or sport = :8787 )'
```

Expected health shape:

```json
{
  "state": "ready",
  "service": "goldencode",
  "auth_mode": "credential",
  "provider": "goldencode",
  "phase": "cn1-loopback"
}
```

Check that the effective pool is Tencent-only without printing secrets:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml exec -T gateway sh -lc '
for k in MEDCODE_PUBLIC_MODEL_ID MEDCODE_IMAGE_GENERATION_ENABLED GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL GATEWAY_PUBLIC_PHASE; do
  printf "%s=%s\n" "$k" "$(printenv "$k")"
done
if printenv MEDCODE_OPENROUTER_API_KEY >/dev/null 2>&1; then
  echo openrouter_env=present
else
  echo openrouter_env=absent
fi
'
docker compose -p codex_gateway_cn1 -f compose.azure.yml exec -T gateway node -e '
  const value = JSON.parse(process.env.MEDCODE_PUBLIC_MODELS_JSON);
  const members = value.goldencode?.pool?.members ?? [];
  const summary = members.map(({id, runtime, upstreamModel}) => ({id, runtime, upstreamModel}));
  if (JSON.stringify(summary) !== JSON.stringify([{
    id: "goldencode-tencent", runtime: "tencent", upstreamModel: "glm-5.2"
  }])) process.exit(1);
  console.log(JSON.stringify(summary));
'
```

## Temporary-Key Smoke

Use the admin CLI inside the container. The full key is sensitive; keep it in a
shell variable and revoke it after the smoke.

```bash
cd /opt/codex-gateway-cn1/current
COMPOSE='docker compose -p codex_gateway_cn1 -f compose.azure.yml'
DB=/var/lib/codex-gateway/gateway.db
USER_ID="goldencode-cn1-smoke-$(date +%s)"

issue_json="$($COMPOSE exec -T gateway node apps/admin-cli/dist/index.js --db "$DB" issue \
  --user "$USER_ID" \
  --user-label "$USER_ID" \
  --label goldencode-cn1-smoke \
  --scope code \
  --expires-days 1 \
  --rpm 20 \
  --rpd 100 \
  --concurrent 2)"

token="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).token));')"
prefix="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).credential.prefix));')"

curl -fsS -H "Authorization: Bearer $token" \
  http://127.0.0.1:18787/v1/models

curl -fsS -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -H "x-medcode-client-session-id: cn1-smoke-session" \
  --data '{"model":"goldencode","messages":[{"role":"user","content":"Reply with exactly: cn1-goldencode-ok"}],"max_tokens":32}' \
  http://127.0.0.1:18787/v1/chat/completions

$COMPOSE exec -T gateway node apps/admin-cli/dist/index.js --db "$DB" revoke "$prefix" >/dev/null
$COMPOSE exec -T gateway node apps/admin-cli/dist/index.js --db "$DB" disable-user "$USER_ID" >/dev/null
```

## Tencent-Only Routing Smoke

Send at least one real request and verify its request event. The only accepted
result is:

```text
goldencode-tencent / tencent / glm-5.2 / status=ok
```

Then verify request events with:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  events --user <temporary-smoke-user> --limit 20
```

For every successful smoke event, these fields should match:

```text
public_model_id=goldencode
upstream_account_id=goldencode-tencent
upstream_runtime=tencent
upstream_model=glm-5.2
reasoning_effort=medium
status=ok
```

Any post-change Qianfan, Aliyun or OpenRouter GLM-5.2 event is a routing
regression. Stop the rollout and inspect the effective env before sending more
traffic.

## Deployment Notes

CN1 Docker Hub access was unstable during the first deployment. The initial
runtime image was loaded from the Azure-validated `codex_gateway_test-gateway`
image and re-tagged as `codex_gateway_cn1-gateway:latest`; runtime behavior is
controlled by CN1's separate env file, not by the Azure env.

Docker daemon proxy was configured through the local CN1 `mihomo` proxy to help
future image pulls:

```text
/etc/systemd/system/docker.service.d/http-proxy.conf
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
```

On 2026-08-04, no-key HTTPS probes through CN1 Mihomo reached OpenAI, xAI and
Gemini and received application-layer 401, 401 and 403. Read-only inspection
also found that the CN1 process currently listens on a wildcard `:7890`, not
loopback as previously assumed; host/cloud ingress controls were not changed in
this task, so do not describe that listener alone as proof of public reachability
or safety. A separate security review should narrow it without disrupting the
Docker daemon proxy dependency.

The approved image-egress implementation no longer tunnels to CN1. The current
CN1 binary plus active node/config snapshot were copied through SSH to a
dedicated R760 private-network container. R760 publishes no proxy/controller
port, only its public Gateway receives proxy variables, and exact `NO_PROXY`
keeps Tencent direct. Do not repoint R760 to CN1 `:7890` or open either host's
proxy listener. See `r760-mihomo-image-egress.md` for the active topology and
remaining Gemini supported-region limitation.

If a future deploy builds on CN1, confirm Docker can pull base images first.
If Docker Hub remains unstable, prefer loading a trusted image artifact and
tagging it to `codex_gateway_cn1-gateway:latest`.

## Stop And Start

Stop only the CN1 Gateway:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml stop gateway
```

Start it again:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml up -d --no-build gateway
curl -fsS http://127.0.0.1:18787/gateway/health
```

Do not use the Azure compose project name `codex_gateway_test` on CN1.
