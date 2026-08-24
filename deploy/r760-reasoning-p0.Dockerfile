ARG BASE_GATEWAY_IMAGE
FROM ${BASE_GATEWAY_IMAGE}

USER root

COPY --chown=codexgw:codexgw apps/gateway/dist /app/apps/gateway/dist
COPY --chown=codexgw:codexgw apps/admin-cli/dist /app/apps/admin-cli/dist
COPY --chown=codexgw:codexgw packages/core/dist /app/packages/core/dist
COPY --chown=codexgw:codexgw packages/store-sqlite/dist /app/packages/store-sqlite/dist

RUN chmod -R a=rX \
      /app/apps/gateway/dist \
      /app/apps/admin-cli/dist \
      /app/packages/core/dist \
      /app/packages/store-sqlite/dist \
  && test -r /app/apps/gateway/dist/index.js \
  && test -r /app/apps/admin-cli/dist/index.js \
  && test -r /app/packages/core/dist/index.js \
  && test -r /app/packages/store-sqlite/dist/index.js

USER codexgw
