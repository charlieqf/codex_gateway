ARG BASE_GATEWAY_IMAGE
FROM ${BASE_GATEWAY_IMAGE}
ARG RELEASE_REVISION
LABEL org.opencontainers.image.revision=${RELEASE_REVISION}
USER root
COPY --chown=codexgw:codexgw apps/gateway/dist /app/apps/gateway/dist
COPY --chown=codexgw:codexgw apps/research-worker/dist /app/apps/research-worker/dist
COPY --chown=codexgw:codexgw packages/core/dist /app/packages/core/dist
COPY --chown=codexgw:codexgw packages/store-sqlite/dist /app/packages/store-sqlite/dist
COPY --chown=codexgw:codexgw packages/research-agent/dist /app/packages/research-agent/dist
RUN chmod -R a=rX /app/apps/gateway/dist /app/apps/research-worker/dist /app/packages/core/dist /app/packages/store-sqlite/dist /app/packages/research-agent/dist
USER codexgw
