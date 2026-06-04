# Volcengine First Deployment

This is the simple first release path: one Volcengine ECS instance, one Node.js app process or
Docker container, one private `data/` directory or Docker volume, and backend-only TOS credentials.

## Security Boundary

- Set `REELYAI_ACCESS_TOKEN` to a strong random value on any public deployment. It gates all writes
  plus `/api/state` and `/api/diagnostics` behind an `x-reelyai-access` header; the web UI prompts
  for it once. Without it, anyone who can reach the server can drive every paid generation API.
- Set `REELYAI_SESSION_GENERATION_DAILY_CAP` to bound paid submissions per session per day.
- Do not set `ARK_AGENT_PLAN_KEY` on the public server. Each visitor enters their own Agent Plan
  token in the ReelyAI top bar.
- User Agent Plan tokens are keyed by an HttpOnly browser cookie and are not returned by
  `/api/state` or written to `data/cinema-store.json`. The Docker Compose deploy runs a private
  Postgres container on the ECS by default and stores rows encrypted. To use external Volcengine
  RDS instead, set `REELYAI_DATABASE_URL` to that PostgreSQL connection string plus
  `REELYAI_AGENT_PLAN_KEY_ENCRYPTION_SECRET`.
- TOS credentials are server-side environment variables. Use a private TOS bucket when possible;
  ReelyAI writes signed URLs for Seedance workers.
- `data/cinema-store.json` can contain TOS signed URLs and generated media paths. Keep `data/`
  on a private disk/volume and never publish it as a static bucket.

## ECS + One-Command Deploy

1. Create an ECS instance on Volcengine.
   - OS: Ubuntu 22.04 or Debian 12
   - Public IP: enabled
   - Security group: open `22/tcp` for SSH and `80/tcp` + `443/tcp` for the public URL
   - Disk: use a data disk or make the system disk large enough for generated media

2. Run the deploy script from your local checkout. It copies the repo to ECS, writes only backend
   TOS credentials to `deploy/.env.production`, installs Docker if needed, then starts Docker
   Compose with Caddy in front.

```bash
export REELYAI_ECS_HOST=<ecs-public-ip>
export REELYAI_ECS_USER=root
export APP_PUBLIC_URL=https://<your-domain>
export TOS_ACCESS_KEY_ID=<server-side tos ak>
export TOS_SECRET_ACCESS_KEY=<server-side tos sk>
export TOS_REGION=cn-beijing
export TOS_ENDPOINT=tos-cn-beijing.volces.com
export TOS_BUCKET=<private bucket>

./deploy/deploy-to-ecs.sh
```

The script intentionally does **not** forward `ARK_AGENT_PLAN_KEY`.
Set `REELYAI_DEPLOY_DRY_RUN=1` to validate inputs without SSH/rsync.

3. Verify from your local machine.

```bash
curl -sS https://<your-domain>/api/healthz
curl -sS https://<your-domain>/api/credentials/agent-plan
```

Open:

```text
https://<your-domain>
```

The user should click "配置 Agent Plan" in the top bar and paste their own Agent Plan token before
calling Seedream / Seedance models.

By default, browser-provided Agent/Coding Plan tokens are used for VLM review and reference video
analysis through the Plan base URL (`/api/plan/v3`) with `doubao-seed-2.0-pro`. Standard Ark
credentials (`VISION_REVIEW_API_KEY` / `VISION_REVIEW_MODEL`) remain available as a fallback when
no browser Plan key is present. Do not send `seed-2-0-pro-260328` to `/api/plan/v3`; that is a
standard Ark model id.

## Manual Docker Compose On ECS

If you prefer to SSH manually:

```bash
curl -fsSL https://get.docker.com | sh
cd cinema_agent
cp deploy/.env.production.example deploy/.env.production
vi deploy/.env.production
docker compose -f deploy/docker-compose.volcengine.yml up -d --build
docker compose -f deploy/docker-compose.volcengine.yml logs -f --tail=120
```

## Monitoring And Release Gate

- Release gate (run before every deploy): `npm run verify:release`. See [observability.md](observability.md)
  and [release-checklist.md](release-checklist.md).
- Optional self-hosted monitoring (Prometheus + Grafana + Alertmanager + blackbox + Feishu alerts):

```bash
docker compose -f deploy/docker-compose.volcengine.yml -f deploy/docker-compose.observability.yml up -d
```

All monitoring ports bind to `127.0.0.1` only; reach Grafana/Prometheus via an SSH tunnel.

## Manual systemd/Caddy On ECS

If the ECS cannot pull Docker Hub images reliably, use the systemd/Caddy fallback:

```bash
cd cinema_agent
cp deploy/.env.production.example deploy/.env.production
vi deploy/.env.production
export APP_PUBLIC_URL=https://<your-domain>
bash deploy/remote-start-systemd.sh
```

This path uses the system Node.js runtime, installs Caddy from the OS package mirror, builds the app
with Linux-native dependencies, and runs ReelyAI as `reelyai-agent.service`.

## Temporary HTTPS With Cloudflare Quick Tunnel

If ACME HTTP-01 / TLS-ALPN validation from Let's Encrypt cannot reach the ECS EIP, a first-release
HTTPS URL can be exposed with Cloudflare Quick Tunnel:

```bash
# Install cloudflared first, then:
export REELYAI_TUNNEL_TARGET=http://127.0.0.1:80
bash deploy/start-cloudflare-quick-tunnel.sh
```

The script prints a `https://*.trycloudflare.com` URL. Set `APP_PUBLIC_URL` to that URL and restart
`reelyai-agent`. Quick Tunnel URLs are convenient for validation but may change after tunnel
recreation; use a purchased domain and a named tunnel or DNS-based certificate flow for a stable
production URL.

## Domain And HTTPS

For a real public URL, put a Volcengine ALB / CLB or Nginx/Caddy reverse proxy in front of port
`5173`, bind your domain, and enable HTTPS. Then set:

```bash
APP_PUBLIC_URL=https://<your-domain>
REELYAI_COOKIE_SECURE=1
```

If you only test over plain HTTP, set `REELYAI_COOKIE_SECURE=0`; do not use that for production.

### Current First Release Topology

The first public release is currently reachable at:

```text
https://reelyai.app
```

Traffic path:

```text
reelyai.app (Vercel DNS/edge HTTPS)
  -> reelyai-vercel-proxy production deployment
  -> https://tapes-indexed-rome-ment.trycloudflare.com
  -> Cloudflare Quick Tunnel on Volcengine ECS
  -> Caddy :80 on ECS
  -> ReelyAI Node app on 127.0.0.1:5173
```

The application process still runs on Volcengine ECS. Vercel and Cloudflare are only public HTTPS
edge/proxy layers for the first release. Keep `APP_PUBLIC_URL=https://reelyai.app` and
`REELYAI_COOKIE_SECURE=1` in `/opt/reelyai-agent/app/deploy/.env.production`.

## First-Release Limits

- Run one replica while sessions/assets/shots still use the built-in JSON store.
- The Docker Compose deploy persists user Agent Plan tokens in the `reelyai-postgres` Docker volume.
  If you use the systemd fallback without PostgreSQL, restarting the process clears user tokens and
  users can paste them again.
- Browser Agent/Coding Plan tokens are scoped per user and can run Seedream / Seedance plus VLM
  review by default. VLM review uses Plan model names such as `doubao-seed-2.0-pro`.
- Generated media and the JSON store live in the Docker volume `reelyai-data`.

## Later High-Concurrency Upgrade

- Move sessions/assets/shots/token usage from `data/cinema-store.json` to PostgreSQL or Redis +
  object metadata.
- Add TTL/rotation controls to the encrypted user Agent Plan key store.
- Put Seedance polling, VLM review, stitching, and narration into a queue worker.
- Store final media in TOS and serve via signed download routes or CDN.
- Run multiple web replicas behind ALB with sticky sessions until the token store is externalized.
