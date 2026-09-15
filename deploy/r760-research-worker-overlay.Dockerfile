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
LABEL org.opencontainers.image.revision="${RELEASE_REVISION}"
RUN chmod -R a=rX /app/apps/research-worker/dist /app/packages/research-agent/dist
USER codexgw
