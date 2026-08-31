FROM node:22.23.2-trixie-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY packages/ ./packages/

# Seed prebuild-install with natively-fetched binaries (scripts/prefetch-prebuilds.mjs).
# Empty in local builds, which falls back to prebuild-install's network fetch.
COPY prebuilds/ /prebuilds/
ENV npm_config_ipshipyard_node_datachannel_local_prebuilds=/prebuilds

RUN npm ci
RUN npm run build

COPY services/herald/server ./herald/server/

RUN cd herald/server && npm ci && npm run build

# Drop dev dependencies once everything is compiled.
RUN npm prune --omit=dev \
    && cd herald/server && npm prune --omit=dev

# The build needs devDependencies and the runtime needs none of them. Layers are
# additive, so pruning in a later layer of one image reclaims nothing -- the
# install has to happen in a stage that is discarded (#987).
FROM node:22.23.2-trixie-slim

WORKDIR /app

# Only what the process opens at runtime: the pruned dependency trees, the
# compiled output, and the workspace packages they resolve through. The data
# directory is an absolute path outside this tree (/app/server/data, per
# ARCHON_HERALD_DATA_DIR) and is supplied by a volume.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/herald ./herald

WORKDIR /app/herald

CMD ["node", "server/dist/index.js"]
