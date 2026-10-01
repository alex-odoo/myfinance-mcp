# Build stage: the full install carries the prisma CLI that generates the client.
FROM oven/bun:1.3-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN bunx prisma generate

# Runtime: production dependencies only. Bun installs peer dependencies by
# default, which pulled the prisma CLI, typescript and pglite back in, hence
# --omit=peer (~100 MB of node_modules instead of ~400).
FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit=peer
COPY --from=build /app/src/generated ./src/generated
COPY src ./src

# Commit being deployed (deploy.sh passes it); /health reports it. Last
# layer, so a new sha never invalidates the install/generate cache.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

USER bun

EXPOSE 8788
CMD ["bun", "run", "src/index.ts"]
