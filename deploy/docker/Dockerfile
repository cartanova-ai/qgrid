# syntax=docker/dockerfile:1.7
FROM node:26.12.1-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Speech aligner for OpenAI speech timing: onnxruntime-node (linux-x64 binaries only; keep the version
# equal to packages/api's devDependency) and the MMS-FA int8 model (CC BY-NC 4.0, see NOTICE). These
# layers come before Claude Code and qgrid so a release does not make servers download them again.
ARG ONNXRUNTIME_VERSION=1.31.1
RUN npm install --global --ignore-scripts "onnxruntime-node@${ONNXRUNTIME_VERSION}" \
    && cd /usr/local/lib/node_modules/onnxruntime-node/bin/napi-v6 \
    && rm -rf darwin win32 linux/arm64 \
    && npm cache clean --force
ADD --checksum=sha256:d93c3b2f62e9fc42a61964867944ecb8733069882ed9352b5ad2df9ce26e198a \
    https://github.com/cartanova-ai/qgrid/releases/download/aligner-model-v1/mms-300m-fa-int8.onnx \
    /opt/qgrid/models/mms-300m-fa-int8.onnx
COPY MODEL-NOTICE.md /opt/qgrid/models/NOTICE.md
ENV QGRID_ALIGNER_MODEL=/opt/qgrid/models/mms-300m-fa-int8.onnx
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
