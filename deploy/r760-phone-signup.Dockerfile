ARG BASE_GATEWAY_IMAGE
FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN npx vitest run apps/gateway/src/billing-identity-coordination.test.ts apps/gateway/src/phone-auth-routes.test.ts apps/gateway/src/services/phone-auth-service.test.ts apps/gateway/src/services/openai-compatible-provider.test.ts apps/gateway/src/index.test.ts apps/gateway/src/openai-compat.test.ts apps/gateway/src/responses-compat.test.ts apps/gateway/src/services/provider-stream.test.ts apps/gateway/src/services/vision-input-policy.test.ts apps/gateway/src/services/vision-request-recovery.test.ts apps/gateway/src/services/native-tool-failover.test.ts apps/gateway/src/services/chat-runtime-dispatcher.test.ts apps/gateway/src/http/error-response.test.ts apps/gateway/src/http/observation.test.ts apps/gateway/src/vision-asset-routes.test.ts apps/gateway/src/services/vision-asset-service.test.ts packages/store-sqlite/src/phone-auth.test.ts packages/store-sqlite/src/index.test.ts

FROM ${BASE_GATEWAY_IMAGE} AS runtime
ARG GATEWAY_REVISION
USER root
COPY --from=verify /app/apps/gateway /app/apps/gateway
COPY --from=verify /app/packages/core /app/packages/core
COPY --from=verify /app/packages/store-sqlite /app/packages/store-sqlite
LABEL org.opencontainers.image.revision="${GATEWAY_REVISION}"
RUN chmod -R a=rX /app/apps/gateway /app/packages/core /app/packages/store-sqlite
USER codexgw
