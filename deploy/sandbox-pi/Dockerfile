# node:22-bookworm-slim, pinned 2026-11-08 (multi-platform index).
# Pi runs inside the qgrid API process (official @ai-sdk/harness-pi); this image is only the
# remote filesystem and shell. Nothing listens inside and no credentials are ever mounted.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash git python3 ripgrep curl jq unzip ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI v2.103.3: official release binaries and pinned SHA-256 checksums.
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) checksum=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d ;; \
      arm64) checksum=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63 ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_${arch}.tar.gz" -o /tmp/gh.tar.gz; \
    echo "$checksum  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /tmp "gh_2.103.3_linux_${arch}/bin/gh"; \
    install -m 0755 "/tmp/gh_2.103.3_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_2.103.3_linux_${arch}"

RUN mkdir -p /workspace && chown node:node /workspace

WORKDIR /workspace
USER node
ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]
