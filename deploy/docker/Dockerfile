FROM node:22.22.1-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_VERSION=2.1.296
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force

COPY qgrid-cli.tgz /tmp/qgrid-cli.tgz
ARG QGRID_VERSION
RUN test -n "$QGRID_VERSION" \
    && npm install --global /tmp/qgrid-cli.tgz \
    && test "$(node -p 'require("/usr/local/lib/node_modules/@cartanova/qgrid-cli/package.json").version')" = "$QGRID_VERSION" \
    && rm /tmp/qgrid-cli.tgz \
    && npm cache clean --force

COPY entrypoint.mjs /opt/qgrid/entrypoint.mjs
LABEL org.opencontainers.image.source="https://github.com/cartanova-ai/qgrid" \
    org.opencontainers.image.version="${QGRID_VERSION}"
USER node
WORKDIR /usr/local/lib/node_modules/@cartanova/qgrid-cli/bundle
EXPOSE 44900
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "/opt/qgrid/entrypoint.mjs"]
