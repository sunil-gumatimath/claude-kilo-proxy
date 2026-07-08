# syntax=docker/dockerfile:1
FROM oven/bun:1-alpine

WORKDIR /app

# Non-root user
RUN addgroup -S proxy && adduser -S proxy -G proxy

COPY package.json ./
COPY src ./src

USER proxy

ENV PROXY_HOST=0.0.0.0
ENV PROXY_PORT=4181
EXPOSE 4181

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4181/health || exit 1

CMD ["bun", "run", "src/index.ts"]
