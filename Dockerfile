# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/admin-cli/package.json apps/admin-cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/provider-codex/package.json packages/provider-codex/package.json
COPY packages/store-sqlite/package.json packages/store-sqlite/package.json

RUN npm ci

COPY apps apps
COPY packages packages
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ARG CODEX_CLI_VERSION=0.125.0

ENV NODE_ENV=production
ENV GATEWAY_AUTH_MODE=credential
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=8787
ENV GATEWAY_SQLITE_PATH=/var/lib/codex-gateway/gateway.db
ENV CODEX_HOME=/var/lib/codex-gateway/codex-home
ENV CODEX_WORKDIR=/app
ENV CODEX_SKIP_GIT_REPO_CHECK=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --home-dir /var/lib/codex-gateway --shell /usr/sbin/nologin codexgw \
  && mkdir -p /var/lib/codex-gateway/codex-home /var/log/codex-gateway \
  && chown -R codexgw:codexgw /var/lib/codex-gateway /var/log/codex-gateway \
  && npm install -g @openai/codex@${CODEX_CLI_VERSION}

COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps /app/apps
COPY --from=build /app/packages /app/packages

USER codexgw

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/gateway/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "--workspace", "@codex-gateway/gateway", "run", "start"]
