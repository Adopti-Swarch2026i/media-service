# ────────────────────────────────────────────────────────────────
# Stage 1 — Build
# ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ────────────────────────────────────────────────────────────────
# Stage 2 — Production runtime
# ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Install curl for HTTPS healthchecks (BusyBox wget does not support TLS)
RUN apk add --no-cache curl

# Only production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled JS from builder
COPY --from=builder /app/dist ./dist

EXPOSE 8084

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8084/api/media/health || exit 1

CMD ["node", "dist/index.js"]
