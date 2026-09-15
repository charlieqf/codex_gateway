ARG BASE_GATEWAY_IMAGE
FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN node artifacts/write-delivery-contract-r3-2026-09-15/verify-fixtures.mjs
RUN npx vitest run apps/gateway/src packages/core/src packages/store-sqlite/src --maxWorkers=2

FROM ${BASE_GATEWAY_IMAGE} AS runtime
ARG GATEWAY_REVISION
USER root
COPY --from=verify /app/apps/gateway /app/apps/gateway
COPY --from=verify /app/packages/core /app/packages/core
COPY --from=verify /app/packages/store-sqlite /app/packages/store-sqlite
COPY --from=verify /app/artifacts/write-delivery-contract-r3-2026-09-15 /app/artifacts/write-delivery-contract-r3-2026-09-15
LABEL org.opencontainers.image.revision="${GATEWAY_REVISION}"
RUN chmod -R a=rX /app/apps/gateway /app/packages/core /app/packages/store-sqlite /app/artifacts/write-delivery-contract-r3-2026-09-15
USER codexgw
