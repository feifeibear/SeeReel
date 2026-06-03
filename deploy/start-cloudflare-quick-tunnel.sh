#!/usr/bin/env bash
set -euo pipefail

TARGET_URL="${REELYAI_TUNNEL_TARGET:-http://127.0.0.1:80}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"

if [[ ! -x "$CLOUDFLARED_BIN" ]]; then
  echo "cloudflared is required at $CLOUDFLARED_BIN." >&2
  echo "Install it from https://github.com/cloudflare/cloudflared/releases/latest first." >&2
  exit 2
fi

cat >/etc/systemd/system/reelyai-cloudflared.service <<SERVICE
[Unit]
Description=ReelyAI Cloudflare Quick Tunnel
After=network-online.target reelyai-agent.service caddy.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$CLOUDFLARED_BIN tunnel --no-autoupdate --url $TARGET_URL
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now reelyai-cloudflared

echo "Waiting for trycloudflare.com URL..."
for _ in {1..60}; do
  url="$(journalctl -u reelyai-cloudflared --no-pager -n 80 | grep -Eo 'https://[-a-zA-Z0-9.]+trycloudflare.com' | tail -n 1 || true)"
  if [[ -n "$url" ]]; then
    echo "$url"
    exit 0
  fi
  sleep 2
done

journalctl -u reelyai-cloudflared --no-pager -n 120 >&2
exit 3
