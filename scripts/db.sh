#!/usr/bin/env bash
# 本地数据库：自动选择 Docker Compose v2（docker compose）或 v1（docker-compose）。
# up 会等到 PostgreSQL 真正接受连接才返回，不依赖 --wait 参数（v1 不支持）。
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
else
  compose=(docker-compose)
fi

case "${1:-}" in
  up)
    "${compose[@]}" up -d postgres
    for _ in $(seq 1 60); do
      if "${compose[@]}" exec -T postgres pg_isready -U bankpilot -d bankpilot >/dev/null 2>&1; then
        echo "postgres ready on 127.0.0.1:54329"
        exit 0
      fi
      sleep 2
    done
    echo "postgres did not become ready in time" >&2
    exit 1
    ;;
  down)
    "${compose[@]}" down
    ;;
  verify)
    "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U bankpilot -d bankpilot < db/invariants.sql
    ;;
  *)
    echo "usage: scripts/db.sh up|down|verify" >&2
    exit 2
    ;;
esac
