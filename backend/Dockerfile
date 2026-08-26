# Single-stage: no build step. Node strips TS types at runtime (see engines.node
# in package.json), so there is nothing to compile ahead of time.
FROM node:25-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

CMD ["node", "src/index.js"]
