FROM node:22.15.0-bullseye-slim

WORKDIR /app

COPY package*.json ./
COPY packages/ ./packages/

RUN npm ci
RUN npm run build

COPY services/herald/server ./herald/server/

RUN cd herald/server && npm ci && npm run build

WORKDIR /app/herald

CMD ["node", "server/dist/index.js"]
