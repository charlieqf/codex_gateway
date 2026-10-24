# Build from a committed archive. BASE_WORKER_IMAGE must have the same locked
# dependencies; the release controller checks this before building.
ARG BASE_WORKER_IMAGE
FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN node node_modules/vitest/vitest.mjs run --maxWorkers=4

FROM ${BASE_WORKER_IMAGE} AS runtime
ARG GATEWAY_REVISION
USER root
COPY --from=verify /app/apps/research-worker /app/apps/research-worker
COPY --from=verify /app/packages /app/packages
COPY --from=verify /app/docs/research/采访skill /app/docs/research/采访skill
COPY --from=verify /app/scripts/research-worker-health.mjs /app/scripts/research-worker-health.mjs
LABEL org.opencontainers.image.revision="${GATEWAY_REVISION}"
RUN chmod -R a=rX /app/apps/research-worker /app/packages /app/docs/research/采访skill \
  && chmod 0555 /app/scripts/research-worker-health.mjs
USER codexgw
