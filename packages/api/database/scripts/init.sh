#!/bin/bash
set -e

# .env 로드
if [ -f "$(dirname "$0")/../../.env" ]; then
  export $(grep -v '^#' "$(dirname "$0")/../../.env" | xargs)
fi

HOST=${DB_HOST}
PORT=${DB_PORT}
USER=${DB_USER}
PASSWORD=${DB_PASSWORD}

export PGPASSWORD=$PASSWORD

for DB in qgrid qgrid_test; do
  if psql -h $HOST -p $PORT -U $USER -lqt | cut -d \| -f 1 | grep -qw $DB; then
    echo "✓ $DB already exists"
  else
    psql -h $HOST -p $PORT -U $USER -c "CREATE DATABASE $DB;"
    echo "✓ $DB created"
  fi
done
