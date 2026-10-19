# syntax=docker/dockerfile:1
#
# razorbills-whatsapp container image.
#
# The default image is lean: the official WhatsApp Cloud API connector is the
# only connector shipped. The authorization-gated WhatsApp Web connector
# (whatsapp-web.js + puppeteer + a bundled Chromium) is OPTIONAL and only baked
# in when you explicitly ask for it:
#
#   docker build --build-arg INSTALL_WEB_CONNECTOR=true -t razorbills-whatsapp:web .
#
# There is NO database and NO Redis. All state lives under DATA_DIR (default
# /app/data), which MUST be mounted from a persistent, access-restricted volume
# so WhatsApp sessions and API keys survive restarts and redeployments.
#
# The runtime process is unprivileged (the `node` user). Chromium's own sandbox
# is NEVER disabled by this image; see the README for the privileges the web
# variant needs.
#
# NOTE: this image has not been built in the development environment used to
# write this migration (Docker was unavailable). Treat it as untested until you
# build it yourself.

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# "true" installs the optional web-connector stack and its bundled Chromium.
ARG INSTALL_WEB_CONNECTOR=false
# Never download a browser unless we are deliberately building the web variant.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
RUN if [ "$INSTALL_WEB_CONNECTOR" = "true" ]; then \
      PUPPETEER_SKIP_DOWNLOAD=false npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm ci --omit=dev --omit=optional --no-audit --no-fund; \
    fi \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ARG INSTALL_WEB_CONNECTOR=false

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    PUPPETEER_SKIP_DOWNLOAD=true

# tini reaps child processes and forwards signals so graceful shutdown works.
# Chromium's shared libraries are only installed for the web variant.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && if [ "$INSTALL_WEB_CONNECTOR" = "true" ]; then \
      apt-get install -y --no-install-recommends \
        fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
        libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 \
        libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
        libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
        libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxss1 \
        libxtst6; \
    fi \
 && rm -rf /var/lib/apt/lists/*

# Application code and the dependency tree built in the previous stage.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY scripts ./scripts
# The pre-built dashboard (see "Frontend dashboard" in the README). Build it on
# the host with `npm run build:frontend` before `docker build`; if it is absent
# the service still starts and serves a friendly 503 page at /ui/.
COPY public ./public

# Run as the unprivileged `node` user that ships with the base image. DATA_DIR
# is the only writable location the app needs; it is private to that user (the
# rest of the tree is read-only to the process). It is a VOLUME so the session
# and credential files are never baked into an image layer.
RUN mkdir -p /app/data \
 && chown -R node:node /app/data \
 && chmod 700 /app/data
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]
USER node

# Only the API port is exposed. There is no remote-debugging port: Chromium is
# launched without --remote-debugging-port, so DevTools is never reachable.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
