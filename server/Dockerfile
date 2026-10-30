# Apname — backend VPS untuk Docker
# Node 20, API + WebSocket + sync iNOX terjadwal (server/src/server.js).
# Build context untuk file ini adalah folder server/ (lihat
# docker-compose.yml: backend.build.context = ./server).
# Runtime membutuhkan env dari .env: DATABASE_URL, APNAME_JWT_SECRET,
# dan opsional INOX_USERNAME, INOX_PASSWORD, SYNC_INTERVAL_MIN, PORT.
# File ini TIDAK berisi secret apa pun.

FROM node:20-alpine
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
EXPOSE 4000
CMD ["node", "src/server.js"]
