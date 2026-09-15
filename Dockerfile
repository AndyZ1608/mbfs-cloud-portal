# ===== Stage 1: build frontend =====
FROM node:20-alpine AS webbuild
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ===== Stage 2: runtime =====
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=webbuild /build/web/dist ./public

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "index.js"]
