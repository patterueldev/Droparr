# syntax=docker/dockerfile:1

# Droparr — single image, works on linux/amd64 (home server) and linux/arm64 (dev Mac).
# Build multi-arch with:  docker buildx build --platform linux/amd64,linux/arm64 -t droparr .

# ---------- build ----------
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @droparr/web build

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    DROPARR_DATA=/data \
    DROPARR_CONFIG=/config/config.json \
    DROPARR_WEB_DIST=/app/apps/web/dist
RUN corepack enable
WORKDIR /app

COPY --from=build /app ./

EXPOSE 3100
VOLUME ["/data", "/config"]

# Runs the Fastify server (serving the built web UI + API).
CMD ["pnpm", "--filter", "@droparr/server", "start"]
