#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Deploy ReelyAI to an existing Volcengine ECS instance over SSH.

Required:
  REELYAI_ECS_HOST        ECS public IP or domain

Optional:
  REELYAI_ECS_USER        SSH user, default root
  REELYAI_ECS_PORT        SSH port, default 22
  REELYAI_ECS_DIR         Remote app dir, default ~/reelyai-agent
  APP_PUBLIC_URL          Public URL, default https://$REELYAI_ECS_HOST.sslip.io for IPv4 hosts
  ACME_EMAIL              Optional email for Caddy/Let's Encrypt notices
  REELYAI_DEPLOY_DRY_RUN  Set to 1 to validate inputs without SSH/rsync

Backend TOS env is read from the current shell and written only to the remote .env.production:
  TOS_ACCESS_KEY_ID
  TOS_SECRET_ACCESS_KEY
  TOS_BUCKET
  TOS_REGION              default cn-beijing
  TOS_ENDPOINT            default tos-cn-beijing.volces.com

This script intentionally does NOT forward ARK_AGENT_PLAN_KEY. Public users enter their own
Agent Plan token in the ReelyAI web UI.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

required_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: $name" >&2
    exit 2
  fi
}

required_env REELYAI_ECS_HOST
required_env TOS_ACCESS_KEY_ID
required_env TOS_SECRET_ACCESS_KEY
required_env TOS_BUCKET

ECS_USER="${REELYAI_ECS_USER:-root}"
ECS_PORT="${REELYAI_ECS_PORT:-22}"
ECS_DIR="${REELYAI_ECS_DIR:-~/reelyai-agent}"
ssh_opts=(-p "$ECS_PORT")
if [[ -n "${REELYAI_ECS_KEY:-}" ]]; then
  ssh_opts=(-i "$REELYAI_ECS_KEY" -p "$ECS_PORT")
fi
default_public_url="https://${REELYAI_ECS_HOST}"
if [[ "$REELYAI_ECS_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  default_public_url="https://${REELYAI_ECS_HOST}.sslip.io"
fi
PUBLIC_URL="${APP_PUBLIC_URL:-$default_public_url}"
CADDY_SITE_ADDRESS="${PUBLIC_URL%%#*}"
CADDY_SITE_ADDRESS="${CADDY_SITE_ADDRESS%%\?*}"
CADDY_SITE_ADDRESS="${CADDY_SITE_ADDRESS%/}"
TOS_REGION_VALUE="${TOS_REGION:-cn-beijing}"
TOS_ENDPOINT_VALUE="${TOS_ENDPOINT:-tos-cn-beijing.volces.com}"
TOS_KEY_PREFIX_VALUE="${TOS_KEY_PREFIX:-cinema-agent/storyboards}"
TOS_PRESIGN_VALUE="${TOS_PRESIGN_EXPIRES_SEC:-604800}"
COOKIE_SECURE_VALUE="0"
if [[ "$PUBLIC_URL" == https://* ]]; then
  COOKIE_SECURE_VALUE="1"
fi

remote="${ECS_USER}@${REELYAI_ECS_HOST}"
ssh_cmd=(ssh "${ssh_opts[@]}" "$remote")
rsync_cmd=(rsync -az --delete -e "ssh ${ssh_opts[*]}")

shell_quote() {
  printf "%q" "$1"
}

env_line() {
  local key="$1"
  local value="${2:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '%s="%s"\n' "$key" "$value"
}

echo "Deploying ReelyAI to $remote:$ECS_DIR"
echo "Public URL: $PUBLIC_URL"
echo "Forwarding backend TOS env only; Agent Plan tokens remain user-provided in the browser."

if [[ "${REELYAI_DEPLOY_DRY_RUN:-}" == "1" ]]; then
  echo "Dry run only. Required env is present; no SSH, rsync, Docker, or cloud changes were made."
  echo "Remote env keys to write: NODE_ENV PORT REELYAI_COOKIE_SECURE REELYAI_ACCESS_TOKEN REELYAI_SESSION_GENERATION_DAILY_CAP APP_PUBLIC_URL CADDY_SITE_ADDRESS ACME_EMAIL ARK_AGENT_PLAN_BASE SEEDREAM_AGENT_PLAN_MODEL SEEDANCE_AGENT_PLAN_MODEL SEEDANCE_AGENT_PLAN_FAST_MODEL VISION_REVIEW_* VIDEO_ANALYZE_* TOS_ACCESS_KEY_ID TOS_SECRET_ACCESS_KEY TOS_REGION TOS_ENDPOINT TOS_BUCKET"
  exit 0
fi

"${ssh_cmd[@]}" "mkdir -p $(shell_quote "$ECS_DIR")"

"${rsync_cmd[@]}" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.claude' \
  --exclude '.cursor/skills' \
  ./ "$remote:$ECS_DIR/"

remote_env="$(
  env_line NODE_ENV production
  env_line PORT 5173
  env_line REELYAI_COOKIE_SECURE "$COOKIE_SECURE_VALUE"
  env_line REELYAI_ACCESS_TOKEN "${REELYAI_ACCESS_TOKEN:-}"
  env_line REELYAI_SESSION_GENERATION_DAILY_CAP "${REELYAI_SESSION_GENERATION_DAILY_CAP:-1000}"
  env_line REELYAI_SEED_DEMO "${REELYAI_SEED_DEMO:-1}"
  env_line APP_PUBLIC_URL "$PUBLIC_URL"
  env_line CADDY_SITE_ADDRESS "$CADDY_SITE_ADDRESS"
  env_line ACME_EMAIL "${ACME_EMAIL:-}"
  env_line ARK_AGENT_PLAN_BASE https://ark.cn-beijing.volces.com/api/plan/v3
  env_line SEEDREAM_AGENT_PLAN_MODEL doubao-seedream-5.0-lite
  env_line SEEDANCE_AGENT_PLAN_MODEL doubao-seedance-2-0-260128
  env_line SEEDANCE_AGENT_PLAN_FAST_MODEL doubao-seedance-2-0-fast-260128
  env_line SEED_PROMPT_AGENT_PLAN_MODEL ""
  env_line PROMPT_REWRITE_AGENT_PLAN_MODEL ""
  env_line AGENT_PLAN_TEXT_MODEL ""
  env_line REELYAI_VISION_REVIEW_USE_AGENT_PLAN "${REELYAI_VISION_REVIEW_USE_AGENT_PLAN:-}"
  env_line VISION_REVIEW_AGENT_PLAN_MODEL "${VISION_REVIEW_AGENT_PLAN_MODEL:-doubao-seed-2.0-pro}"
  env_line VIDEO_ANALYZE_AGENT_PLAN_MODEL "${VIDEO_ANALYZE_AGENT_PLAN_MODEL:-doubao-seed-2.0-pro}"
  env_line VISION_REVIEW_API_KEY "${VISION_REVIEW_API_KEY:-}"
  env_line VISION_REVIEW_API_BASE "${VISION_REVIEW_API_BASE:-https://ark.ap-southeast.bytepluses.com/api/v3}"
  env_line VISION_REVIEW_MODEL "${VISION_REVIEW_MODEL:-seed-2-0-pro-260328}"
  env_line VIDEO_ANALYZE_MODEL "${VIDEO_ANALYZE_MODEL:-}"
  env_line TOS_ACCESS_KEY_ID "$TOS_ACCESS_KEY_ID"
  env_line TOS_SECRET_ACCESS_KEY "$TOS_SECRET_ACCESS_KEY"
  env_line TOS_REGION "$TOS_REGION_VALUE"
  env_line TOS_ENDPOINT "$TOS_ENDPOINT_VALUE"
  env_line TOS_BUCKET "$TOS_BUCKET"
  env_line TOS_KEY_PREFIX "$TOS_KEY_PREFIX_VALUE"
  env_line TOS_PRESIGN_EXPIRES_SEC "$TOS_PRESIGN_VALUE"
  env_line TOS_PUBLIC_BASE_URL "${TOS_PUBLIC_BASE_URL:-}"
  env_line SEEDANCE_RATIO "${SEEDANCE_RATIO:-16:9}"
  env_line SEEDANCE_GENERATE_AUDIO "${SEEDANCE_GENERATE_AUDIO:-true}"
  env_line SEEDANCE_WATERMARK "${SEEDANCE_WATERMARK:-false}"
  env_line SEEDANCE_POLL_MS "${SEEDANCE_POLL_MS:-5000}"
  env_line SEEDANCE_TIMEOUT_MS "${SEEDANCE_TIMEOUT_MS:-900000}"
  env_line VOLC_TTS_APPID "${VOLC_TTS_APPID:-}"
  env_line VOLC_TTS_TOKEN "${VOLC_TTS_TOKEN:-}"
  env_line VOLC_TTS_RESOURCE_ID "${VOLC_TTS_RESOURCE_ID:-seed-tts-1.0}"
  env_line VOLC_TTS_VOICE_TYPE "${VOLC_TTS_VOICE_TYPE:-zh_male_M392_conversation_wvae_bigtts}"
  env_line VOLC_TTS_BASE "${VOLC_TTS_BASE:-https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse}"
  env_line VOLC_TTS_RATE "${VOLC_TTS_RATE:-24000}"
)"

printf "%s\n" "$remote_env" | "${ssh_cmd[@]}" "cat > $(shell_quote "$ECS_DIR")/deploy/.env.production && chmod 600 $(shell_quote "$ECS_DIR")/deploy/.env.production"

"${ssh_cmd[@]}" "cd $(shell_quote "$ECS_DIR") && bash deploy/remote-start.sh"

echo "Done. Open: $PUBLIC_URL"
echo "Health: $PUBLIC_URL/api/healthz"
echo "Readiness: $PUBLIC_URL/api/readyz"
