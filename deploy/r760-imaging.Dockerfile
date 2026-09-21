# Build only from a git archive of a tested main commit. No dirty-tree context.
ARG BASE_GATEWAY_IMAGE
FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN node node_modules/vitest/vitest.mjs run --maxWorkers=4
RUN node scripts/ops/free-paid-quota-smoke.mjs

FROM ${BASE_GATEWAY_IMAGE} AS runtime
ARG GATEWAY_REVISION
USER root
COPY --from=verify /app/apps/gateway /app/apps/gateway
LABEL org.opencontainers.image.revision="${GATEWAY_REVISION}"
RUN chmod -R a=rX /app/apps/gateway
USER codexgw
