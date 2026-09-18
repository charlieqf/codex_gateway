# Build only from an immutable, scoped Git archive. The runtime base is the
# inspected current Gateway image; this does not recreate any other service.
ARG BASE_GATEWAY_IMAGE
FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN npm test -- --maxWorkers=4
RUN node scripts/ops/free-paid-quota-smoke.mjs

FROM verify AS production-dependencies
RUN npm prune --omit=dev

FROM ${BASE_GATEWAY_IMAGE} AS runtime
ARG GATEWAY_REVISION
USER root
COPY --from=production-dependencies /app/apps /app/apps
COPY --from=production-dependencies /app/packages /app/packages
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/package.json /app/package.json
COPY scripts/query-identity-requests.mjs /app/scripts/query-identity-requests.mjs
COPY scripts/ops/audit-phone-auth-readiness-r760.mjs scripts/ops/audit-phone-conflicts-r760.mjs /app/scripts/ops/
LABEL org.opencontainers.image.revision="${GATEWAY_REVISION}"
RUN chmod -R a=rX /app/apps /app/packages \
    && chmod 0444 /app/scripts/query-identity-requests.mjs /app/scripts/ops/audit-phone-auth-readiness-r760.mjs /app/scripts/ops/audit-phone-conflicts-r760.mjs
USER codexgw
