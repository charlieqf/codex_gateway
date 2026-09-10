ARG BASE_GATEWAY_IMAGE
FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN npx vitest run apps/gateway/src/billing-identity-coordination.test.ts apps/gateway/src/phone-auth-routes.test.ts apps/gateway/src/services/phone-auth-service.test.ts apps/gateway/src/services/openai-compatible-provider.test.ts apps/gateway/src/index.test.ts packages/store-sqlite/src/phone-auth.test.ts packages/store-sqlite/src/index.test.ts

FROM ${BASE_GATEWAY_IMAGE} AS runtime
ARG GATEWAY_REVISION
USER root
COPY --from=verify /app/apps/gateway /app/apps/gateway
COPY --from=verify /app/packages/core /app/packages/core
COPY --from=verify /app/packages/store-sqlite /app/packages/store-sqlite
LABEL org.opencontainers.image.revision="${GATEWAY_REVISION}"
RUN chmod -R a=rX /app/apps/gateway /app/packages/core /app/packages/store-sqlite
USER codexgw
