FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.client.json vitest.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY index.html styles.css ./

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG ODPSCMD_VERSION=0.52.3
ARG ODPSCMD_DOWNLOAD_URL=https://github.com/aliyun/aliyun-odps-console/releases/download/v0.52.3-public/odpscmd_public.zip

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8068
ENV DATA_DIR=/app/data
ENV WORKSPACE_ROOT=/workspaces
ENV CLAUDE_COMMAND=

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl openjdk-17-jre-headless socat unzip \
    && curl --fail --location --retry 4 --retry-delay 2 "$ODPSCMD_DOWNLOAD_URL" --output /tmp/odpscmd_public.zip \
    && mkdir -p /opt/odpscmd \
    && unzip -q /tmp/odpscmd_public.zip -d /opt/odpscmd \
    && test -x /opt/odpscmd/bin/odpscmd \
    && ln -s /opt/odpscmd/bin/odpscmd /usr/local/bin/odpscmd \
    && rm -f /tmp/odpscmd_public.zip \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.odpscmd.version="$ODPSCMD_VERSION"

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/data /workspaces && chown -R node:node /app /workspaces /opt/odpscmd

USER node

EXPOSE 8068

CMD ["node", "dist/server.js"]
