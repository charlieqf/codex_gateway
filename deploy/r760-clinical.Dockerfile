# Build and test only a committed git archive; retain the pinned production base.
ARG BASE_GATEWAY_IMAGE
FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN node node_modules/vitest/vitest.mjs run --maxWorkers=4

FROM ${BASE_GATEWAY_IMAGE} AS runtime
ARG GATEWAY_REVISION
USER root
COPY --from=verify /app/apps/gateway /app/apps/gateway
COPY --from=verify /app/packages /app/packages
LABEL org.opencontainers.image.revision="${GATEWAY_REVISION}"
RUN chmod -R a=rX /app/apps/gateway /app/packages
USER codexgw
