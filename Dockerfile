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

ARG PYODPS_VERSION=0.13.0

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8068
ENV DATA_DIR=/app/data
ENV WORKSPACE_ROOT=/workspaces
ENV CLAUDE_COMMAND=

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates python3 python3-venv socat \
    && python3 -m venv /opt/pyodps \
    && /opt/pyodps/bin/pip install --no-cache-dir "pyodps==$PYODPS_VERSION" \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/pyodps/bin:${PATH}"

LABEL org.opencontainers.image.pyodps.version="$PYODPS_VERSION"

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/data /workspaces && chown -R node:node /app /workspaces /opt/pyodps

USER node

EXPOSE 8068

CMD ["node", "dist/server.js"]
