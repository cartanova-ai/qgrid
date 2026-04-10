#!/bin/sh
set -e

# DB 준비 대기
echo "Waiting for PostgreSQL..."
until pg_isready -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" 2>/dev/null; do
  sleep 1
done
echo "PostgreSQL is ready."

# 스키마 적용 (IF NOT EXISTS라 멱등)
PGPASSWORD="${DB_PASSWORD:-postgres}" psql \
  -h "$DB_HOST" \
  -p "${DB_PORT:-5432}" \
  -U "${DB_USER:-postgres}" \
  -d "${DB_NAME:-qgrid}" \
  -f /app/schema/schema_0.1.0.sql 2>/dev/null || true

# 서버 시작
exec pnpm -C packages/api start
