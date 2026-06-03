#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y docker.io docker-compose-v2
  else
    curl -fsSL https://get.docker.com | sh
  fi
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required but unavailable after Docker install." >&2
  exit 3
fi

docker compose -f deploy/docker-compose.volcengine.yml up -d --build
docker compose -f deploy/docker-compose.volcengine.yml ps
