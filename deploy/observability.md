# ReelyAI 发布与监控体系

## 发布前质量闸门

本地发布前先跑发布门禁（含权限/计费防护验证）：

```bash
npm run verify:release
```

这会执行 `verify:offline` 的全部检查，再加上 `smoke:guardrails`：

- TypeScript + Vite 构建：`npm run build`
- Canvas CRUD API smoke：`npm run smoke:canvas-crud`
- fetch retry 行为 smoke：`tsx scripts/smoke-fetch-retry.ts`
- narration 纯单元检查：`node scripts/smoke_narration_units.mjs`
- **权限 + 计费防护 smoke：`npm run smoke:guardrails`**

`smoke:guardrails` 启动一个临时生产实例（所有付费 key 强制置空，**绝不会真实花钱**）并断言：

- 访问令牌门禁：`/api/healthz` 开放；`/api/state`、`/api/diagnostics`、写操作无令牌返回 401。
- 生产环境缺 key 不再「静默假成功」：生成接口返回错误而非占位图 URL。
- 单会话每日生成额度：超过 `REELYAI_SESSION_GENERATION_DAILY_CAP` 后返回 429。

完整的发布前人工验收项见 [release-checklist.md](release-checklist.md)。

需要真实或测试凭证的检查单独跑：

```bash
npm run verify:integration
```

线上发布后 smoke：

```bash
REELYAI_BASE_URL=https://your-domain.example npm run smoke:production
```

## GitHub Actions

- `.github/workflows/ci.yml`：PR/main 自动跑 `verify:release`（offline + guardrails）+ Docker build。
- `.github/workflows/integration.yml`：手动/nightly 跑凭证相关集成验证。
- `.github/workflows/deploy.yml`：手动部署 staging/production，部署前先过 `verify:release` 门禁，部署后跑 `smoke:production`；production 可配置 GitHub Environment approval。

部署需要的新增 Secrets / Variables：

- `REELYAI_ACCESS_TOKEN`（Secret）：访问令牌门禁的共享 token。
- `REELYAI_SESSION_GENERATION_DAILY_CAP`（Variable，可选）：单会话每日生成额度。

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
- `reelyai_ready`（1=硬依赖就绪）
- `reelyai_component_up{component=...}`（含 tos/seedream/seedance 等软依赖；readyz 对软依赖只 warn+200，这里可单独告警）
- `reelyai_access_guard_enabled`（1=访问令牌门禁开启）
- `reelyai_generation_daily_cap` / `reelyai_generation_submissions_today`
- `reelyai_generation_submissions_total{operation}` / `reelyai_generation_blocked_total{operation,reason}`
- `reelyai_access_denied_total{method,route}`

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
- Alertmanager: `127.0.0.1:9093`
- node-exporter: `127.0.0.1:9100`
- blackbox-exporter: `127.0.0.1:9115`
- feishu-alert-relay: 仅 Docker 网络内 `:8088`（不对外暴露）

监控栈包含：Prometheus（抓取 + 告警规则）、Alertmanager（路由告警）、feishu-alert-relay（转飞书）、blackbox-exporter（探活 healthz/readyz）、Grafana（看板，已 provisioning 数据源与「ReelyAI 总览」看板）、node-exporter（主机指标）。

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

## 告警接入飞书

告警链路：Prometheus 规则（`deploy/alerts.yml`）→ Alertmanager（`deploy/alertmanager.yml`）→ feishu-alert-relay（`scripts/feishu-alert-relay.ts`）→ 飞书群机器人。

配置步骤：

1. 在飞书群添加「自定义机器人」，复制 webhook URL；如开启「签名校验」，记下 secret。
2. 在 `deploy/.env.production` 设置：

```bash
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
FEISHU_WEBHOOK_SECRET=    # 仅在开启签名校验时填写
GRAFANA_ADMIN_PASSWORD=   # 强密码
```

3. 启动/重启监控栈（见上）。relay 会读取这两个环境变量。

测试一条告警是否能落到飞书（在 ECS 上，于 Docker 网络内直接打 relay）：

```bash
docker compose -f deploy/docker-compose.volcengine.yml -f deploy/docker-compose.observability.yml \
  exec reelyai node -e "fetch('http://feishu-alert-relay:8088/alert',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:'firing',alerts:[{status:'firing',labels:{severity:'P0',alertname:'TestAlert'},annotations:{summary:'测试告警',description:'这是一条测试'}}]})}).then(r=>r.text()).then(console.log)"
```

## 告警规则

实际规则见 `deploy/alerts.yml`，按 severity 分级：

P0（Alertmanager 10s 触发、1h 重复）：

- `ReelyAIServiceDown`：`up{job="reelyai"} == 0` 持续 2m
- `ReelyAINotReady`：`reelyai_ready == 0` 持续 2m
- `ReelyAIHealthProbeFailing`：blackbox `probe_success == 0` 持续 2m
- `ReelyAIHigh5xxRate`：5xx 占比 > 5% 持续 5m
- `ReelyAIStoreSaveErrors`：store 保存出错
- `HostDiskAlmostFull`：磁盘 > 85%

P1：

- `ReelyAIComponentDegraded`：`reelyai_component_up == 0` 持续 10m（含 TOS/Seedance 软依赖降级）
- `ReelyAIHighLatencyP95`：P95 > 2s 持续 10m
- `ReelyAIAccessGuardDisabled`：`reelyai_access_guard_enabled == 0`（线上未配访问令牌）
- `ReelyAIProcessMemoryHigh`：RSS > 1.5GB 持续 10m

P2：

- `ReelyAIGenerationCapBlocking`：近 15m 有生成被额度拦截（用户触顶或额度过低）
- `ReelyAIMediaGrowthHigh`：media 目录 1h 增长 > 5GB

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
