FROM node:22.22.1-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @cartanova/qgrid-cli@2.10.2 @anthropic-ai/claude-code@2.1.296 \
    && npm cache clean --force

COPY entrypoint.mjs /opt/qgrid/entrypoint.mjs
USER node
WORKDIR /usr/local/lib/node_modules/@cartanova/qgrid-cli/bundle
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "/opt/qgrid/entrypoint.mjs"]
