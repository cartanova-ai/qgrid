#!/bin/bash
set -e

HOST=${DB_HOST:-localhost}
PORT=${DB_PORT:-5444}
USER=${DB_USER:-postgres}
PASSWORD=${DB_PASSWORD:-1234}

export PGPASSWORD=$PASSWORD

for DB in bycc bycc_fixture bycc_test; do
  if psql -h $HOST -p $PORT -U $USER -lqt | cut -d \| -f 1 | grep -qw $DB; then
    echo "✓ $DB already exists"
  else
    psql -h $HOST -p $PORT -U $USER -c "CREATE DATABASE $DB;"
    echo "✓ $DB created"
  fi
done
