FROM node:25 AS builder
WORKDIR /app
RUN npm i -g pnpm@10.32.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -C packages/api sonamu build

FROM node:25-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@10.32.0
RUN npm i -g @anthropic-ai/claude-code

# Claude CLI 온보딩 스킵
RUN mkdir -p /root/.claude && echo '{"hasCompletedOnboarding":true,"theme":"dark"}' > /root/.claude/settings.json

# pg_isready, psql 사용을 위해
RUN apt-get update && apt-get install -y postgresql-client && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV LR=remote
ENV HOST=0.0.0.0
ENV PORT=44900

COPY --from=builder /app /app
COPY schema/ /app/schema/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 44900
ENTRYPOINT ["/app/entrypoint.sh"]
