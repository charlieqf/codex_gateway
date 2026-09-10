ARG BASE_RESEARCH_IMAGE
FROM ${BASE_RESEARCH_IMAGE}

ARG REPAIR_REVISION
LABEL org.opencontainers.image.revision=${REPAIR_REVISION}

USER root
COPY --chown=codexgw:codexgw packages/research-agent/dist /app/packages/research-agent/dist
COPY --chown=codexgw:codexgw apps/research-worker/dist /app/apps/research-worker/dist
RUN chmod -R a=rX /app/packages/research-agent/dist /app/apps/research-worker/dist \
    && test -r /app/packages/research-agent/dist/index.js \
    && test -r /app/apps/research-worker/dist/index.js
USER codexgw
