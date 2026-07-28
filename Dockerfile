FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV STATE_FILE_PATH=/data/outbound-state.json

COPY package.json ./
COPY server.mjs ./
COPY app ./app
COPY README.md INTEGRATION_HANDOFF.md ./

RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
