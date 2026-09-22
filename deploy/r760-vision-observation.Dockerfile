# Build only from an immutable, scoped Git archive. The runtime base is the
# inspected current Gateway image; this does not recreate any other service.
# Schema 35 adds a nullable request_events column, so the previous image stays
# readable against the migrated database and image rollback remains available.
ARG BASE_GATEWAY_IMAGE
FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN npm test -- --maxWorkers=4

FROM verify AS production-dependencies
RUN npm prune --omit=dev

FROM ${BASE_GATEWAY_IMAGE} AS runtime
ARG GATEWAY_REVISION
USER root
COPY --from=production-dependencies /app/apps /app/apps
COPY --from=production-dependencies /app/packages /app/packages
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/package.json /app/package.json
LABEL org.opencontainers.image.revision="${GATEWAY_REVISION}"
RUN chmod -R a=rX /app/apps /app/packages
USER codexgw
