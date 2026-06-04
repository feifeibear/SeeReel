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

set -a
source deploy/.env.production
set +a

# The original first-release fallback used host-level systemd Caddy on ports 80/443. When switching
# to the Compose stack, free those ports immediately before starting the Compose Caddy container.
if systemctl is-active --quiet caddy 2>/dev/null; then
  systemctl stop caddy
fi
if systemctl is-active --quiet seereel-agent 2>/dev/null; then
  systemctl stop seereel-agent
fi

docker compose -f deploy/docker-compose.volcengine.yml up -d --build
docker compose -f deploy/docker-compose.volcengine.yml ps

for _ in {1..60}; do
  if docker compose -f deploy/docker-compose.volcengine.yml exec -T reelyai node -e "Promise.all([fetch('http://127.0.0.1:5173/api/healthz'), fetch('http://127.0.0.1:5173/api/readyz')]).then(([h,r])=>process.exit(h.ok&&r.ok?0:1)).catch(()=>process.exit(1))"; then
    exit 0
  fi
  sleep 5
done

docker compose -f deploy/docker-compose.volcengine.yml logs --tail=120 reelyai >&2
exit 5
