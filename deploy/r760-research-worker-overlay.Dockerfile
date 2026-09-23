# Worker-only overlay: replaces three package dists on an older worker image.
# Unsafe once @codex-gateway/core (or another package these dists import) has
# changed since the base image: on 2026-09-23 the new store-sqlite needed a core
# export the base lacked and the worker would have crashed on start. Prefer
# running the worker on the Gateway image of the same revision (all packages
# consistent), and always import the worker module graph in the candidate image
# before cutover.
ARG BASE_RESEARCH_IMAGE

FROM node:24-bookworm-slim AS verify
WORKDIR /app
COPY . /app
RUN npm ci --include=dev
RUN npm run build
RUN npx vitest run packages/research-agent/src apps/research-worker/src

FROM ${BASE_RESEARCH_IMAGE} AS runtime
ARG RELEASE_REVISION
USER root
COPY --from=verify --chown=codexgw:codexgw /app/apps/research-worker/dist /app/apps/research-worker/dist
COPY --from=verify --chown=codexgw:codexgw /app/packages/research-agent/dist /app/packages/research-agent/dist
COPY --from=verify --chown=codexgw:codexgw /app/packages/store-sqlite/dist /app/packages/store-sqlite/dist
LABEL org.opencontainers.image.revision="${RELEASE_REVISION}"
RUN chmod -R a=rX /app/apps/research-worker/dist /app/packages/research-agent/dist /app/packages/store-sqlite/dist
USER codexgw
