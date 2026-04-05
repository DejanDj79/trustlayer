#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  echo "[trustlayer] loaded env from $ENV_FILE"
fi

API_HOST="${HOST:-127.0.0.1}"
API_PORT="${PORT:-8787}"
WEB_BIND_HOST="${WEB_HOST:-127.0.0.1}"
WEB_BIND_PORT="${WEB_PORT:-5173}"

echo "[trustlayer] starting api on ${API_HOST}:${API_PORT}"
(cd "$ROOT_DIR/apps/api" && HOST="$API_HOST" PORT="$API_PORT" node src/server.mjs) &
API_PID=$!

echo "[trustlayer] starting web on ${WEB_BIND_HOST}:${WEB_BIND_PORT}"
(cd "$ROOT_DIR/apps/web" && HOST="$WEB_BIND_HOST" PORT="$WEB_BIND_PORT" node dev-server.mjs) &
WEB_PID=$!

cleanup() {
  echo
  echo "[trustlayer] shutting down..."
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

wait "$API_PID" "$WEB_PID"
