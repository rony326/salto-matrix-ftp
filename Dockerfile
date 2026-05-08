# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# ── Runtime stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine

LABEL org.opencontainers.image.title="Salto Access Matrix"
LABEL org.opencontainers.image.description="Zutrittmatrix für Salto Pro Access Space mit FTP/SFTP Auto-Import"

WORKDIR /app

# Non-root user
RUN addgroup -S salto && adduser -S salto -G salto

COPY --from=builder /app/node_modules ./node_modules
COPY server.js sync.js parser.js ./
COPY public/ ./public/

# Persistent volumes
RUN mkdir -p /data /config && chown -R salto:salto /data /config /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CONFIG_FILE=/config/ftp.json \
    SYNC_INTERVAL_SEC=300

EXPOSE 3000

VOLUME ["/data", "/config"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

USER salto

CMD ["node", "server.js"]
