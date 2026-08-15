FROM node:22.23.2-trixie-slim

WORKDIR /app

COPY package*.json ./
COPY packages/ ./packages/

# Seed prebuild-install with natively-fetched binaries (scripts/prefetch-prebuilds.mjs).
# Empty in local builds, which falls back to prebuild-install's network fetch.
COPY prebuilds/ /prebuilds/
ENV npm_config_sqlite3_local_prebuilds=/prebuilds \
    npm_config_ipshipyard_node_datachannel_local_prebuilds=/prebuilds

RUN npm ci
RUN npm run build

COPY services/herald/server ./herald/server/

RUN cd herald/server && npm ci && npm run build

WORKDIR /app/herald

CMD ["node", "server/dist/index.js"]
