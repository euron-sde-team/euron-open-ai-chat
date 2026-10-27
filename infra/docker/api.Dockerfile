# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# API image. One image, four commands:
#
#   node dist/index.js                         HTTP on PORT (default 5036)
#   node dist/worker.js                        BullMQ worker (no inbound port)
#   node dist/migrate.js                       forward-only migrations (one-off task)
#   node dist/cli.js admin:create --email ...  bootstrap the first admin (one-off task)
#
#   docker build -f infra/docker/api.Dockerfile -t open-chat-api .
#
# The four entry points are esbuild bundles (pnpm --filter @open-chat/api build).
# Everything is bundled, the pure-JS file readers included (unpdf, mammoth, exceljs),
# except sharp: a native binary. The runtime stage carries a node_modules with only
# sharp, at exactly the version the lockfile resolved, installed with its prebuilt
# binary for the platform being built (pg-native is never installed: pg falls back to
# its JS client).
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Download every package in the lockfile first: this layer only changes with the lockfile.
# package.json too: it pins the pnpm version (packageManager) and carries the overrides
# the frozen lockfile is checked against.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter @open-chat/api...
RUN pnpm --filter @open-chat/api build
# sharp at the version the workspace resolved, with its prebuilt binary for this
# platform.
RUN mkdir /sharp && cd /sharp \
 && sharp="$(node -p "require('/repo/apps/api/node_modules/sharp/package.json').version")" \
 && echo '{"name":"runtime","private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock "sharp@${sharp}"

FROM ${NODE_IMAGE} AS runtime
# DATA_DIR only matters for STORAGE=local or MAIL_MODE=outbox. /tmp/data suits ECS (read-only
# root filesystem, writable /tmp); compose mounts a volume at /app/data instead.
ENV NODE_ENV=production TZ=UTC PORT=5036 \
    MIGRATIONS_DIR=/app/db/migrations DATA_DIR=/tmp/data
WORKDIR /app
# tini reaps zombies and forwards SIGTERM so the server drains and the worker stops cleanly.
# fontconfig + fonts-dejavu-core: sharp (librsvg) needs a real font, found through
# fontconfig, to draw text in SVGs (avatars, previews); without one every glyph is a box.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data && chown node:node /app/data
COPY --from=build --chown=node:node /sharp/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
# The bundled runner reads MIGRATIONS_DIR (db/migrate.ts), set above.
COPY --from=build --chown=node:node /repo/db/migrations ./db/migrations
USER node
EXPOSE 5036
# Liveness for the HTTP process. The worker has no port: compose and ECS override this.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5036)+'/up').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
