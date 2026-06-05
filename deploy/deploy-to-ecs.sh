#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Deploy SeeReel to an existing Volcengine ECS instance over SSH.

Required:
  SEEREEL_ECS_HOST        ECS public IP or domain

Optional:
  SEEREEL_ECS_USER        SSH user, default root
  SEEREEL_ECS_PORT        SSH port, default 22
  SEEREEL_ECS_DIR         Remote app dir, default ~/seereel-agent
  APP_PUBLIC_URL          Public URL, default https://$SEEREEL_ECS_HOST.sslip.io for IPv4 hosts
  ACME_EMAIL              Optional email for Caddy/Let's Encrypt notices
  SEEREEL_DEPLOY_DRY_RUN  Set to 1 to validate inputs without SSH/rsync

Backend TOS env is read from the current shell and written only to the remote .env.production:
  TOS_ACCESS_KEY_ID
  TOS_SECRET_ACCESS_KEY
  TOS_BUCKET
  TOS_REGION              default cn-beijing
  TOS_ENDPOINT            default tos-cn-beijing.volces.com

This script intentionally does NOT forward ARK_AGENT_PLAN_KEY. Public users enter their own
Agent Plan token in the SeeReel web UI. Browser-entered keys are persisted to PostgreSQL:
by default this deploy creates a Postgres container on the Volcengine ECS; set
SEEREEL_DATABASE_URL to use an external Volcengine RDS PostgreSQL instance instead.
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

ECS_HOST="${SEEREEL_ECS_HOST:-${REELYAI_ECS_HOST:-}}"
if [[ -z "$ECS_HOST" ]]; then
  echo "Missing required env: SEEREEL_ECS_HOST or REELYAI_ECS_HOST" >&2
  exit 2
fi
ECS_USER="${SEEREEL_ECS_USER:-${REELYAI_ECS_USER:-root}}"
ECS_PORT="${SEEREEL_ECS_PORT:-${REELYAI_ECS_PORT:-22}}"
ECS_DIR="${SEEREEL_ECS_DIR:-${REELYAI_ECS_DIR:-~/seereel-agent}}"
ssh_opts=(
  -p "$ECS_PORT"
  -o BatchMode=yes
  -o "ConnectTimeout=${SEEREEL_ECS_CONNECT_TIMEOUT:-20}"
  -o "ServerAliveInterval=${SEEREEL_ECS_SERVER_ALIVE_INTERVAL:-15}"
  -o "ServerAliveCountMax=${SEEREEL_ECS_SERVER_ALIVE_COUNT_MAX:-4}"
  -o "StrictHostKeyChecking=${SEEREEL_ECS_STRICT_HOST_KEY_CHECKING:-accept-new}"
  -o ControlMaster=auto
  -o "ControlPath=${SEEREEL_ECS_CONTROL_PATH:-/tmp/seereel-deploy-ssh-%C}"
  -o "ControlPersist=${SEEREEL_ECS_CONTROL_PERSIST:-120}"
)
ECS_KEY="${SEEREEL_ECS_KEY:-${REELYAI_ECS_KEY:-}}"
if [[ -n "$ECS_KEY" ]]; then
  ssh_opts=(-i "$ECS_KEY" "${ssh_opts[@]}")
fi
default_public_url="https://${ECS_HOST}"
if [[ "$ECS_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  default_public_url="https://${ECS_HOST}.sslip.io"
fi
remote="${ECS_USER}@${ECS_HOST}"
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

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  fi
}

read_remote_env_value() {
  local key="$1"
  local remote_file="$ECS_DIR/deploy/.env.production"
  "${ssh_cmd[@]}" "if [ -f $(shell_quote "$remote_file") ]; then grep -m1 '^${key}=' $(shell_quote "$remote_file") | sed -e 's/^[^=]*=//' -e 's/^\"//' -e 's/\"$//'; fi" 2>/dev/null || true
}

env_value() {
  local key="$1"
  local fallback="${2:-}"
  local local_value="${!key:-}"
  local legacy_key=""
  if [[ "$key" == SEEREEL_* ]]; then
    legacy_key="REELYAI_${key#SEEREEL_}"
  fi
  if [[ -n "$local_value" ]]; then
    printf "%s" "$local_value"
    return
  fi
  if [[ -n "$legacy_key" && -n "${!legacy_key:-}" ]]; then
    printf "%s" "${!legacy_key}"
    return
  fi
  local remote_value
  remote_value="$(read_remote_env_value "$key")"
  if [[ -n "$remote_value" ]]; then
    printf "%s" "$remote_value"
    return
  fi
  if [[ -n "$legacy_key" ]]; then
    remote_value="$(read_remote_env_value "$legacy_key")"
    if [[ -n "$remote_value" ]]; then
      printf "%s" "$remote_value"
      return
    fi
  fi
  printf "%s" "$fallback"
}

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required env: $name" >&2
    exit 2
  fi
}

echo "Deploying SeeReel to $remote:$ECS_DIR"
echo "Forwarding backend TOS/DB env; Agent Plan tokens remain user-provided in the browser."

if [[ "${SEEREEL_DEPLOY_DRY_RUN:-}" == "1" ]]; then
  echo "Dry run only. Required env is present; no SSH, rsync, Docker, or cloud changes were made."
  echo "Remote env keys to write: NODE_ENV PORT SEEREEL_COMMIT_SHA SEEREEL_COOKIE_SECURE SEEREEL_ACCESS_TOKEN SEEREEL_ADMIN_USER SEEREEL_ADMIN_PASSWORD SEEREEL_SESSION_GENERATION_DAILY_CAP SEEREEL_DATABASE_URL SEEREEL_DATABASE_SSL SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD APP_PUBLIC_URL CADDY_SITE_ADDRESS ACME_EMAIL ARK_AGENT_PLAN_BASE SEEDREAM_AGENT_PLAN_MODEL SEEDANCE_AGENT_PLAN_MODEL SEEDANCE_AGENT_PLAN_FAST_MODEL VISION_REVIEW_* VIDEO_ANALYZE_* TOS_ACCESS_KEY_ID TOS_SECRET_ACCESS_KEY TOS_REGION TOS_ENDPOINT TOS_BUCKET"
  exit 0
fi

"${ssh_cmd[@]}" "mkdir -p $(shell_quote "$ECS_DIR")"

existing_public_url="$(read_remote_env_value APP_PUBLIC_URL)"
PUBLIC_URL="${APP_PUBLIC_URL:-${existing_public_url:-$default_public_url}}"
CADDY_SITE_ADDRESS="${PUBLIC_URL%%#*}"
CADDY_SITE_ADDRESS="${CADDY_SITE_ADDRESS%%\?*}"
CADDY_SITE_ADDRESS="${CADDY_SITE_ADDRESS%/}"
COOKIE_SECURE_VALUE="0"
if [[ "$PUBLIC_URL" == https://* ]]; then
  COOKIE_SECURE_VALUE="1"
fi
echo "Public URL: $PUBLIC_URL"
RELEASE_COMMIT="${SEEREEL_COMMIT_SHA:-${GITHUB_SHA:-}}"
if [[ -z "$RELEASE_COMMIT" ]] && command -v git >/dev/null 2>&1; then
  RELEASE_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
fi
echo "Commit: ${RELEASE_COMMIT:-unknown}"

existing_database_url="$(read_remote_env_value SEEREEL_DATABASE_URL)"
existing_database_ssl="$(read_remote_env_value SEEREEL_DATABASE_SSL)"
existing_encryption_secret="$(read_remote_env_value SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET)"
existing_admin_user="$(read_remote_env_value SEEREEL_ADMIN_USER)"
existing_admin_password="$(read_remote_env_value SEEREEL_ADMIN_PASSWORD)"
existing_postgres_db="$(read_remote_env_value POSTGRES_DB)"
existing_postgres_user="$(read_remote_env_value POSTGRES_USER)"
existing_postgres_password="$(read_remote_env_value POSTGRES_PASSWORD)"

POSTGRES_DB_VALUE="${POSTGRES_DB:-${SEEREEL_POSTGRES_DB:-${existing_postgres_db:-reelyai}}}"
POSTGRES_USER_VALUE="${POSTGRES_USER:-${SEEREEL_POSTGRES_USER:-${existing_postgres_user:-reelyai}}}"
POSTGRES_PASSWORD_VALUE="${POSTGRES_PASSWORD:-${SEEREEL_POSTGRES_PASSWORD:-${existing_postgres_password:-}}}"
if [[ -z "$POSTGRES_PASSWORD_VALUE" ]]; then
  POSTGRES_PASSWORD_VALUE="$(random_hex)"
fi
DATABASE_URL_VALUE="${SEEREEL_DATABASE_URL:-${existing_database_url:-}}"
if [[ -z "$DATABASE_URL_VALUE" ]]; then
  DATABASE_URL_VALUE="postgres://${POSTGRES_USER_VALUE}:${POSTGRES_PASSWORD_VALUE}@postgres:5432/${POSTGRES_DB_VALUE}"
fi
DATABASE_SSL_VALUE="${SEEREEL_DATABASE_SSL:-${existing_database_ssl:-}}"
ENCRYPTION_SECRET_VALUE="${SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET:-${existing_encryption_secret:-}}"
if [[ -z "$ENCRYPTION_SECRET_VALUE" ]]; then
  ENCRYPTION_SECRET_VALUE="$(random_hex)"
fi
TOS_ACCESS_KEY_ID_VALUE="$(env_value TOS_ACCESS_KEY_ID)"
TOS_SECRET_ACCESS_KEY_VALUE="$(env_value TOS_SECRET_ACCESS_KEY)"
TOS_BUCKET_VALUE="$(env_value TOS_BUCKET)"
require_value TOS_ACCESS_KEY_ID "$TOS_ACCESS_KEY_ID_VALUE"
require_value TOS_SECRET_ACCESS_KEY "$TOS_SECRET_ACCESS_KEY_VALUE"
require_value TOS_BUCKET "$TOS_BUCKET_VALUE"

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
  env_line SEEREEL_COMMIT_SHA "$RELEASE_COMMIT"
  env_line SEEREEL_COOKIE_SECURE "$COOKIE_SECURE_VALUE"
  env_line SEEREEL_ACCESS_TOKEN "$(env_value SEEREEL_ACCESS_TOKEN)"
  env_line SEEREEL_ADMIN_USER "${SEEREEL_ADMIN_USER:-${existing_admin_user:-}}"
  env_line SEEREEL_ADMIN_PASSWORD "${SEEREEL_ADMIN_PASSWORD:-${existing_admin_password:-}}"
  env_line SEEREEL_SESSION_GENERATION_DAILY_CAP "$(env_value SEEREEL_SESSION_GENERATION_DAILY_CAP 1000)"
  env_line SEEREEL_DATABASE_URL "$DATABASE_URL_VALUE"
  env_line SEEREEL_DATABASE_SSL "$DATABASE_SSL_VALUE"
  env_line SEEREEL_AGENT_PLAN_KEY_ENCRYPTION_SECRET "$ENCRYPTION_SECRET_VALUE"
  env_line POSTGRES_DB "$POSTGRES_DB_VALUE"
  env_line POSTGRES_USER "$POSTGRES_USER_VALUE"
  env_line POSTGRES_PASSWORD "$POSTGRES_PASSWORD_VALUE"
  env_line SEEREEL_NODE_IMAGE "$(env_value SEEREEL_NODE_IMAGE docker.m.daocloud.io/library/node:22-bookworm-slim)"
  env_line SEEREEL_CADDY_IMAGE "$(env_value SEEREEL_CADDY_IMAGE docker.m.daocloud.io/library/caddy:2-alpine)"
  env_line SEEREEL_POSTGRES_IMAGE "$(env_value SEEREEL_POSTGRES_IMAGE docker.m.daocloud.io/library/postgres:16-alpine)"
  env_line APP_PUBLIC_URL "$PUBLIC_URL"
  env_line CADDY_SITE_ADDRESS "$CADDY_SITE_ADDRESS"
  env_line ACME_EMAIL "$(env_value ACME_EMAIL)"
  env_line ARK_AGENT_PLAN_BASE https://ark.cn-beijing.volces.com/api/plan/v3
  env_line SEEDREAM_AGENT_PLAN_MODEL doubao-seedream-5.0-lite
  env_line SEEDANCE_AGENT_PLAN_MODEL doubao-seedance-2-0-260128
  env_line SEEDANCE_AGENT_PLAN_FAST_MODEL doubao-seedance-2-0-fast-260128
  env_line SEED_PROMPT_AGENT_PLAN_MODEL ""
  env_line PROMPT_REWRITE_AGENT_PLAN_MODEL ""
  env_line AGENT_PLAN_TEXT_MODEL ""
  env_line SEEREEL_VISION_REVIEW_USE_AGENT_PLAN "$(env_value SEEREEL_VISION_REVIEW_USE_AGENT_PLAN)"
  env_line VISION_REVIEW_AGENT_PLAN_MODEL "$(env_value VISION_REVIEW_AGENT_PLAN_MODEL doubao-seed-2.0-pro)"
  env_line VIDEO_ANALYZE_AGENT_PLAN_MODEL "$(env_value VIDEO_ANALYZE_AGENT_PLAN_MODEL doubao-seed-2.0-pro)"
  env_line VISION_REVIEW_API_KEY "$(env_value VISION_REVIEW_API_KEY)"
  env_line VISION_REVIEW_API_BASE "$(env_value VISION_REVIEW_API_BASE https://ark.ap-southeast.bytepluses.com/api/v3)"
  env_line VISION_REVIEW_MODEL "$(env_value VISION_REVIEW_MODEL seed-2-0-pro-260328)"
  env_line VIDEO_ANALYZE_MODEL "$(env_value VIDEO_ANALYZE_MODEL)"
  env_line TOS_ACCESS_KEY_ID "$TOS_ACCESS_KEY_ID_VALUE"
  env_line TOS_SECRET_ACCESS_KEY "$TOS_SECRET_ACCESS_KEY_VALUE"
  env_line TOS_REGION "$(env_value TOS_REGION cn-beijing)"
  env_line TOS_ENDPOINT "$(env_value TOS_ENDPOINT tos-cn-beijing.volces.com)"
  env_line TOS_BUCKET "$TOS_BUCKET_VALUE"
  env_line TOS_KEY_PREFIX "$(env_value TOS_KEY_PREFIX cinema-agent/storyboards)"
  env_line TOS_PRESIGN_EXPIRES_SEC "$(env_value TOS_PRESIGN_EXPIRES_SEC 604800)"
  env_line TOS_PUBLIC_BASE_URL "$(env_value TOS_PUBLIC_BASE_URL)"
  env_line SEEDANCE_RATIO "$(env_value SEEDANCE_RATIO 16:9)"
  env_line SEEDANCE_GENERATE_AUDIO "$(env_value SEEDANCE_GENERATE_AUDIO true)"
  env_line SEEDANCE_WATERMARK "$(env_value SEEDANCE_WATERMARK false)"
  env_line SEEDANCE_POLL_MS "$(env_value SEEDANCE_POLL_MS 5000)"
  env_line SEEDANCE_TIMEOUT_MS "$(env_value SEEDANCE_TIMEOUT_MS 900000)"
  env_line VOLC_TTS_APPID "$(env_value VOLC_TTS_APPID)"
  env_line VOLC_TTS_TOKEN "$(env_value VOLC_TTS_TOKEN)"
  env_line VOLC_TTS_RESOURCE_ID "$(env_value VOLC_TTS_RESOURCE_ID seed-tts-1.0)"
  env_line VOLC_TTS_VOICE_TYPE "$(env_value VOLC_TTS_VOICE_TYPE zh_male_M392_conversation_wvae_bigtts)"
  env_line VOLC_TTS_BASE "$(env_value VOLC_TTS_BASE https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse)"
  env_line VOLC_TTS_RATE "$(env_value VOLC_TTS_RATE 24000)"
)"

printf "%s\n" "$remote_env" | "${ssh_cmd[@]}" "cat > $(shell_quote "$ECS_DIR")/deploy/.env.production && chmod 600 $(shell_quote "$ECS_DIR")/deploy/.env.production"

"${ssh_cmd[@]}" "cd $(shell_quote "$ECS_DIR") && bash deploy/remote-start.sh"

echo "Done. Open: $PUBLIC_URL"
echo "Health: $PUBLIC_URL/api/healthz"
echo "Readiness: $PUBLIC_URL/api/readyz"
