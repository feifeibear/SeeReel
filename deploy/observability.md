# ReelyAI 发布与监控体系

## 发布前质量闸门

本地发布前先跑：

```bash
npm run verify:offline
```

这会执行：

- TypeScript + Vite 构建：`npm run build`
- Canvas CRUD API smoke：`npm run smoke:canvas-crud`
- fetch retry 行为 smoke：`tsx scripts/smoke-fetch-retry.ts`
- narration 纯单元检查：`node scripts/smoke_narration_units.mjs`

需要真实或测试凭证的检查单独跑：

```bash
npm run verify:integration
```

线上发布后 smoke：

```bash
REELYAI_BASE_URL=https://your-domain.example npm run smoke:production
```

## GitHub Actions

- `.github/workflows/ci.yml`：PR/main 自动跑 offline verify + Docker build。
- `.github/workflows/integration.yml`：手动/nightly 跑凭证相关集成验证。
- `.github/workflows/deploy.yml`：手动部署 staging/production，production 可配置 GitHub Environment approval。

CI 环境设置了：

```bash
REELYAI_SKIP_SKILL_INSTALL=1
```

避免 postinstall 在 CI 中写入本机 agent skill 目录。

## 健康检查端点

### `/api/healthz`

轻量 liveness。Docker/systemd/负载均衡探活使用它。

返回字段：

- `ok`
- `ts`
- `pid`
- `uptimeSec`
- `version`
- `commit`

### `/api/readyz`

readiness。用于判断服务是否能接流量。

检查：

- data 目录可写
- store 文件可读
- media 目录可写
- TOS 配置存在性
- Seedream/Seedance 配置存在性

只有 data/store/media 失败时返回 503；模型/TOS 缺失会作为 warn 返回，便于本地或 Agent Plan 模式仍能启动。

### `/api/diagnostics`

排障端点，返回：

- runtime credential source
- sessions/shots/assets/renders/tokenUsageEvents 数量
- in-flight 任务数
- store/media 大小
- token usage Top 聚合

生产环境不要公网暴露该端点。默认 `deploy/Caddyfile` 对外返回 404。

### `/metrics`

Prometheus text format，默认 Caddy 对公网隐藏，Prometheus 在 Docker 网络内抓取。

当前指标包括：

- `reelyai_http_requests_total`
- `reelyai_http_request_duration_seconds`
- `reelyai_http_inflight_requests`
- `reelyai_store_save_total`
- `reelyai_store_save_duration_seconds`
- `reelyai_store_file_size_bytes`
- `reelyai_store_sessions`
- `reelyai_store_shots`
- `reelyai_store_assets`
- `reelyai_store_renders`
- `reelyai_store_token_usage_events`
- `reelyai_media_dir_size_bytes`
- `reelyai_media_file_count`
- `reelyai_process_uptime_seconds`
- `reelyai_process_memory_rss_bytes`
- `reelyai_inflight_*`
- `reelyai_token_usage_total`

## 启动监控栈

默认业务服务：

```bash
docker compose -f deploy/docker-compose.volcengine.yml up -d --build
```

监控栈：

```bash
docker compose \
  -f deploy/docker-compose.volcengine.yml \
  -f deploy/docker-compose.observability.yml \
  up -d
```

默认端口只绑定 localhost：

- Prometheus: `127.0.0.1:9090`
- Grafana: `127.0.0.1:3000`
- node-exporter: `127.0.0.1:9100`

远程访问建议用 SSH tunnel：

```bash
ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 root@<ecs-host>
```

Grafana 默认用户来自：

```bash
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=change-me
```

生产请在 `deploy/.env.production` 或 shell 中设置强密码。

## 推荐 Grafana Dashboard

### 服务总览

- `up{job="reelyai"}`
- QPS: `rate(reelyai_http_requests_total[5m])`
- 5xx rate: `sum(rate(reelyai_http_requests_total{status=~"5.."}[5m])) / sum(rate(reelyai_http_requests_total[5m]))`
- P95 latency: `histogram_quantile(0.95, sum(rate(reelyai_http_request_duration_seconds_bucket[5m])) by (le, route))`
- inflight requests: `reelyai_http_inflight_requests`
- process RSS: `reelyai_process_memory_rss_bytes`

### 容量与存储

- store 文件大小：`reelyai_store_file_size_bytes`
- media 目录大小：`reelyai_media_dir_size_bytes`
- media 文件数：`reelyai_media_file_count`
- sessions/shots/assets 数量
- in-flight stitch/narration/review/generate 数量

### 成本与用量

- token 使用：`reelyai_token_usage_total`
- 按 provider/model/operation 分组展示。

## 告警建议

P0：

- `up{job="reelyai"} == 0` 持续 2 分钟
- `/api/readyz` smoke 失败持续 2 分钟
- HTTP 5xx rate > 5% 持续 5 分钟
- 磁盘 > 85%
- `increase(reelyai_store_save_total{status="error"}[5m]) > 0`

P1：

- P95 HTTP 延迟 > 2s 持续 10 分钟
- media 目录增长速度异常
- process RSS > 80% 内存预算
- stitch/narration inflight 长时间不下降

P2：

- 4xx 突增
- token 用量超预算
- store 文件大小持续快速增长

## 扩容判断

当前架构仍是单副本优先：

- JSON store 是本地单文件。
- media 是本地目录。
- stitch/narration/review/generate locks 是进程内 Map。

因此不能直接把 app 扩到多副本，否则会出现数据覆盖、媒体不一致、任务锁失效。

先看指标决定扩容方向：

- `reelyai_store_save_duration_seconds` 或 store 文件大小升高：迁移 SQLite/Postgres。
- `reelyai_media_dir_size_bytes` 快速增长：迁移 TOS/CDN，本地只做缓存和清理。
- CPU 高、stitch/narration 慢：限制 ffmpeg 并发，拆 worker，扩 CPU。
- HTTP QPS 高但 store/media/worker 不是瓶颈：先纵向扩容；横向扩容前必须外置 store/media/queue。
- Seedance active tasks 高：加队列、限流、worker 化 poll。

中长期多副本路径：

1. Postgres 存业务状态。
2. TOS/CDN 存媒体。
3. Redis/BullMQ 或云队列承载后台任务。
4. Web API 与 worker 分离。
5. 进程内 locks 改分布式锁。
6. Web 多副本 + worker 按队列长度扩容。
