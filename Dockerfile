FROM oven/bun:1.3-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma.config.ts ./
COPY prisma ./prisma
RUN bunx prisma generate

COPY src ./src

# Commit being deployed (deploy.sh passes it); /health reports it. Last
# layer, so a new sha never invalidates the install/generate cache.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

USER bun

EXPOSE 8788
CMD ["bun", "run", "src/index.ts"]
