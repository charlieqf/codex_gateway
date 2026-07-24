# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/admin-cli/package.json apps/admin-cli/package.json
COPY apps/research-worker/package.json apps/research-worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/provider-codex/package.json packages/provider-codex/package.json
COPY packages/research-agent/package.json packages/research-agent/package.json
COPY packages/store-sqlite/package.json packages/store-sqlite/package.json
COPY scripts/patch-codex-sdk-stdin-epipe.mjs scripts/patch-codex-sdk-stdin-epipe.mjs

RUN npm ci

COPY apps apps
COPY packages packages
COPY docs/research/采访skill docs/research/采访skill
RUN npm run build \
  && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG CODEX_CLI_VERSION=0.144.1

ENV NODE_ENV=production
ENV GATEWAY_AUTH_MODE=credential
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=8787
ENV GATEWAY_SQLITE_PATH=/var/lib/codex-gateway/gateway.db
ENV CODEX_HOME=/var/lib/codex-gateway/codex-home
ENV CODEX_WORKDIR=/app
ENV CODEX_SKIP_GIT_REPO_CHECK=1
ENV CODEX_GATEWAY_CODEX_PATH=/usr/local/bin/codex-gateway-exec

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 999 codexgw \
  && useradd --system --uid 999 --gid 999 --create-home --home-dir /var/lib/codex-gateway --shell /usr/sbin/nologin codexgw \
  && mkdir -p /var/lib/codex-gateway/codex-home /var/log/codex-gateway \
     /var/lib/codex-gateway-research/artifacts \
     /var/lib/codex-gateway-research-backups \
  && chown -R codexgw:codexgw /var/lib/codex-gateway /var/log/codex-gateway \
     /var/lib/codex-gateway-research /var/lib/codex-gateway-research-backups \
  && chmod 0700 /var/lib/codex-gateway-research \
     /var/lib/codex-gateway-research/artifacts \
     /var/lib/codex-gateway-research-backups \
  && npm install -g @openai/codex@${CODEX_CLI_VERSION}

COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps /app/apps
COPY --from=build /app/packages /app/packages
COPY --from=build /app/docs/research/采访skill /app/docs/research/采访skill
COPY config/research.official-identity-registry.v1.json /app/config/research.official-identity-registry.v1.json
COPY scripts/archive-unreferenced-codex-rollouts.mjs /app/scripts/archive-unreferenced-codex-rollouts.mjs
COPY scripts/ops/gateway-request-watchdog.mjs /app/scripts/ops/gateway-request-watchdog.mjs
COPY scripts/research-worker-health.mjs /app/scripts/research-worker-health.mjs
COPY scripts/research-maintenance-health.mjs /app/scripts/research-maintenance-health.mjs
COPY scripts/codex-gateway-exec.sh /usr/local/bin/codex-gateway-exec
COPY scripts/gateway-entrypoint.sh /usr/local/bin/codex-gateway-entrypoint

RUN chmod 0755 /usr/local/bin/codex-gateway-exec /usr/local/bin/codex-gateway-entrypoint \
  && chmod 0444 /app/package.json \
  && chmod 0444 /app/config/research.official-identity-registry.v1.json \
  && chmod -R a=rX /app/apps /app/packages /app/docs/research/采访skill \
  && chmod 0555 /app/scripts/ops/gateway-request-watchdog.mjs \
     /app/scripts/research-worker-health.mjs \
     /app/scripts/research-maintenance-health.mjs

USER codexgw

RUN test -r /app/package.json \
  && test -r /app/apps/gateway/dist/index.js \
  && test -r /app/apps/research-worker/dist/index.js \
  && test -r /app/apps/research-worker/dist/maintenance-index.js \
  && test -r /app/docs/research/采访skill/doctor-research-query/SKILL.md \
  && test -r /app/docs/research/采访skill/literature-review/SKILL.md \
  && test -r /app/docs/research/采访skill/citation-management/SKILL.md \
  && test -r /app/docs/research/采访skill/scientific-writing/SKILL.md \
  && test -r /app/config/research.official-identity-registry.v1.json \
  && test -r /app/packages/core/src/fixtures/phase0.5-compatibility.v1.json

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/gateway/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/codex-gateway-entrypoint"]
CMD ["npm", "--workspace", "@codex-gateway/gateway", "run", "start"]
