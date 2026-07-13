FROM oven/bun:1.3-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

RUN mkdir -p /app/state && chown -R bun:bun /app
USER bun

EXPOSE 8788
CMD ["bun", "run", "src/index.ts"]
