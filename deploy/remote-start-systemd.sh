#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${SEEREEL_REMOTE_APP_DIR:-$(pwd)}"
PUBLIC_URL="${APP_PUBLIC_URL:-}"

if [[ -z "$PUBLIC_URL" ]]; then
  echo "APP_PUBLIC_URL is required for the systemd/Caddy deployment." >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install Node.js before running this script." >&2
  exit 3
fi

node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [[ "$node_major" -lt 22 ]]; then
  echo "Node.js 22+ is required; found $(node -v)." >&2
  exit 3
fi

if ! command -v caddy >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Caddy is required. Install Caddy or use the Docker Compose deployment." >&2
    exit 4
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y caddy
fi

cd "$APP_DIR"

npm config set registry "${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
npm config set replace-registry-host always
npm install --package-lock=false --no-audit --no-fund
npm run build

cat >/etc/systemd/system/seereel-agent.service <<SERVICE
[Unit]
Description=SeeReel Agent Web App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/deploy/.env.production
ExecStart=$(command -v npm) run start
Restart=always
RestartSec=5
TimeoutStopSec=30
LimitNOFILE=65535
User=root

[Install]
WantedBy=multi-user.target
SERVICE

cat >/etc/caddy/Caddyfile <<CADDY
:80 {
  encode zstd gzip
  log {
    output stdout
    format json
  }

  @private path /metrics /api/diagnostics
  handle @private {
    respond "not found" 404
  }

  reverse_proxy 127.0.0.1:5173
}
CADDY

systemctl daemon-reload
systemctl enable --now seereel-agent
systemctl enable --now caddy
systemctl reload caddy

for _ in {1..60}; do
  if curl -fsS http://127.0.0.1:5173/api/healthz >/dev/null && curl -fsS http://127.0.0.1:5173/api/readyz >/dev/null; then
    systemctl is-active seereel-agent
    systemctl is-active caddy
    exit 0
  fi
  sleep 5
done

journalctl -u seereel-agent --no-pager -n 120 >&2
exit 5
