# CN1 GoldenCode Gateway

Last updated: 2026-08-31.

CN1 retains an isolated loopback Gateway and an installed dark edge. Neither
is a public Gateway authority, production fallback or client endpoint. The
supported public endpoint is R760 at
`https://goldencode.instmarket.com.au:1443`.

## Retained Runtime

```text
app root:        /opt/codex-gateway-cn1
current:         /opt/codex-gateway-cn1/current
compose project: codex_gateway_cn1
compose file:    compose.azure.yml
container:       codex_gateway_cn1-gateway-1
listener:        127.0.0.1:18787 -> 8787
```

The retained loopback profile exposes only `goldencode` and was last
configured for Tencent GLM-5.2. Verify live state before any operation; do not
infer current provider subscriptions from this document.

The installed `gw.instmarket.com.au` CN1 Nginx vhost was a dark cutover design.
Do not enable it, change DNS, publish the loopback container or proxy traffic
without explicit network-maintenance authorization. If reactivated through a
separately reviewed plan, it must proxy to R760, never to CN1 loopback.

## Read-Only Check

Run on CN1 using operator-local access details:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml ps
curl -fsS http://127.0.0.1:18787/gateway/health
ss -ltnp '( sport = :18787 or sport = :8787 )'
```

Inspect only non-secret routing fields when required:

```bash
docker compose -p codex_gateway_cn1 -f compose.azure.yml exec -T gateway sh -lc '
for k in MEDCODE_PUBLIC_MODEL_ID MEDCODE_IMAGE_GENERATION_ENABLED GATEWAY_PUBLIC_PHASE; do
  printf "%s=%s\n" "$k" "$(printenv "$k")"
done
'
```

## Safety

- Do not modify CN1 Nginx, DNS, public ports, firewall, Docker daemon or
  MedEvidence services without explicit authorization.
- Do not use `codex_gateway_test`; CN1's project is `codex_gateway_cn1`.
- Do not print the runtime env, provider keys, admin tokens or user keys.
- Do not copy a retired Azure model pool into CN1.
- Do not route R760 image egress through CN1. The current isolated topology is
  documented in [R760 Mihomo Image Egress](./r760-mihomo-image-egress.md).
- Do not use `docker compose down` or remove volumes for a diagnostic check.

Historical edge installation, smoke, cutover and rollback commands remain in
Git history. They are evidence, not current instructions.
