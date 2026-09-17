FROM node:20-alpine

WORKDIR /app

# The warm-up's session window is read in local time, because it means the
# operator's morning rather than a span of UTC. That was free while the clock
# ran on the operator's own Mac; now that it runs here, this container's idea of
# "nine o'clock" is the one that decides when accounts open, and Alpine ships
# with none — so 09:00–13:00 would silently become 11:00–15:00 in Warsaw and the
# first two hours of the working day would be spent refusing to start.
# tzdata is what makes a named zone resolvable at all; override TZ per
# deployment if the team's day moves.
RUN apk add --no-cache tzdata
ENV TZ=Europe/Warsaw

ENV NODE_ENV=production
ENV PORT=3000
ENV STATE_FILE_PATH=/data/outbound-state.json

COPY package.json ./
COPY server.mjs ./
COPY warmup ./warmup
COPY knowledge ./knowledge
COPY contacts ./contacts
COPY app ./app
COPY README.md INTEGRATION_HANDOFF.md ./

RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
