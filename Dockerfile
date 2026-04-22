# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json tsconfig.json tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/admin-cli/package.json apps/admin-cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/provider-codex/package.json packages/provider-codex/package.json
COPY packages/store-sqlite/package.json packages/store-sqlite/package.json

RUN npm install

COPY apps apps
COPY packages packages
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ARG CODEX_CLI_VERSION=0.122.0

ENV NODE_ENV=production
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=8787
ENV CODEX_HOME=/var/lib/codex-gateway/codex-home

WORKDIR /app

RUN useradd --system --create-home --home-dir /var/lib/codex-gateway --shell /usr/sbin/nologin codexgw \
  && mkdir -p /var/lib/codex-gateway/codex-home /var/log/codex-gateway \
  && chown -R codexgw:codexgw /var/lib/codex-gateway /var/log/codex-gateway \
  && npm install -g @openai/codex@${CODEX_CLI_VERSION}

COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps /app/apps
COPY --from=build /app/packages /app/packages

USER codexgw

EXPOSE 8787

CMD ["npm", "--workspace", "@codex-gateway/gateway", "run", "start"]

