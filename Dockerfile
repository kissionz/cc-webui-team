FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8068
ENV DATA_DIR=/app/data
ENV WORKSPACE_ROOT=/workspaces
ENV CLAUDE_COMMAND=claude
ENV CLAUDE_TRANSPORT=pty
ENV CLAUDE_ARGS=

COPY package.json ./
RUN npm install --omit=dev

COPY index.html app.js styles.css README.md ./
COPY claude-code-team-platform-prd.md ./
COPY server.js ./

RUN mkdir -p /app/data /workspaces && chown -R node:node /app /workspaces

USER node

EXPOSE 8068

CMD ["npm", "start"]
