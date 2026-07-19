#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/lib/postgresql/16/bin:/usr/lib/postgresql/15/bin:$PATH"

PGDATA="${PGDATA:-/tmp/pgdata}"
PGPORT="${PGPORT:-5432}"
mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA" 2>/dev/null || true

if ! command -v initdb >/dev/null; then
  # locate initdb
  INITDB=$(find /usr -name initdb 2>/dev/null | head -1)
  PGBIN=$(dirname "$INITDB")
  export PATH="$PGBIN:$PATH"
fi

su -s /bin/bash postgres -c "initdb -D '$PGDATA'" >/tmp/initdb.log 2>&1
echo "host all all 127.0.0.1/32 trust" >> "$PGDATA/pg_hba.conf"
echo "local all all trust" >> "$PGDATA/pg_hba.conf"
su -s /bin/bash postgres -c "pg_ctl -D '$PGDATA' -o \"-p $PGPORT -k /tmp\" -w start"

su -s /bin/bash postgres -c "psql -h /tmp -p $PGPORT -c \"CREATE USER cipherboard WITH PASSWORD 'cipherboard' SUPERUSER;\"" || true
su -s /bin/bash postgres -c "psql -h /tmp -p $PGPORT -c \"CREATE DATABASE cipherboard OWNER cipherboard;\"" || true

export DATABASE_URL="postgres://cipherboard:cipherboard@127.0.0.1:${PGPORT}/cipherboard"
export HOST=127.0.0.1
export PORT=8080
export STATIC_DIR=/app/static
export RUST_LOG=warn

/usr/local/bin/cipherboard-server >/tmp/server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  su -s /bin/bash postgres -c "pg_ctl -D '$PGDATA' -m fast stop" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server died" >&2
    cat /tmp/server.log >&2 || true
    exit 1
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "server did not become healthy" >&2
    cat /tmp/server.log >&2 || true
    exit 1
  fi
done

cd /app/packages/web
export PLAYWRIGHT_BASE_URL=http://127.0.0.1:8080
export CI=1
npx playwright test

echo "e2e passed"
