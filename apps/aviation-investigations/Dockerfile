# AirCase application image. One image serves the `app` (Fastify API
# plus the built web client) and the worker CLI (`ingest`, `migrate`); see
# compose.yaml and docs/RUNBOOK.md. Build it with `pnpm app:up` or
# `docker compose build app`.
#
# The runtime stage mirrors the checkout layout with compiled JavaScript in place
# of TypeScript (`server/`, `worker/`, `shared/` directly under /app), so paths a
# module resolves relative to itself (migrations, verify profiles, the report-link
# seed, `data/`, `dist/web`) are the same as in a checkout.
# Pinned by tag and by the multi-platform index digest; update both together.
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm comes from corepack at the version and sha512 pinned in package.json
# (packageManager); corepack refuses a download with another hash.
RUN corepack enable pnpm && pnpm --version

FROM base AS deps
RUN pnpm install --frozen-lockfile

# Vite web build (dist/web, with font licences) and the server/worker/shared
# TypeScript build (dist/server).
FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runtime
# Package managers are build tools; the runtime keeps only node.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=prod-deps /src/node_modules ./node_modules
COPY --from=build /src/package.json ./
COPY --from=build /src/dist/server/ ./
COPY --from=build /src/dist/web/ ./dist/web/
# Non-TypeScript files that compiled modules read at runtime.
COPY --from=build /src/server/db/migrations/ ./server/db/migrations/
COPY --from=build /src/worker/ingest/verify-profiles/ ./worker/ingest/verify-profiles/
COPY --from=build /src/fixtures/report-links-seed.json ./fixtures/
# Everything above is root-owned and read-only for the runtime user.
USER node
EXPOSE 3000
# The HTTP entry (server/main.ts): API and web client on port 3000.
CMD ["node", "server/main.js"]
