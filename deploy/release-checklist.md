# ReelyAI 发布前验收清单（Release Checklist）

每次修改发布到火山云前，必须按本清单逐项确认。重点是**权限**与**计费**这类容易造成重大金钱和合规风险的功能。

自动门禁（CI / 部署流水线）已覆盖大部分项；标注「手动」的项需人工确认。

## 1. 自动门禁（必须全绿）

```bash
npm run verify:release
```

包含：

- `npm run build`（TypeScript 类型检查 + Vite 构建）
- `npm run smoke:canvas-crud`（画布 CRUD / undo 语义）
- fetch retry 行为、narration 单元
- `npm run smoke:guardrails`（**权限 + 计费防护**，见下）

`smoke:guardrails` 会启动一个临时生产实例（所有付费 key 强制置空，绝不会真实花钱）并断言：

- 访问令牌门禁：`/api/healthz` 开放；`/api/state`、`/api/diagnostics`、写操作在无令牌时返回 401。
- 生产环境缺 key 不再「静默假成功」：生成接口返回错误而非占位图 URL。
- 单会话每日生成额度：超过 `REELYAI_SESSION_GENERATION_DAILY_CAP` 后返回 429。

## 2. 权限 / 暴露面（手动确认）

- [ ] 生产 `deploy/.env.production` 已设置强随机 `REELYAI_ACCESS_TOKEN`（公网部署必填）。
- [ ] Web UI 首次访问会要求输入令牌；输入后功能正常。
- [ ] 直接 `curl https://<public>/api/state` 无令牌 → 401。
- [ ] `curl https://<public>/metrics` 与 `/api/diagnostics` → 404（Caddy 边界屏蔽）。
- [ ] 服务器进程**未**设置个人 `ARK_AGENT_PLAN_KEY`（公网用户自带浏览器令牌）。
- [ ] Grafana / Prometheus / Alertmanager 端口仅绑定 `127.0.0.1`，仅经 SSH 隧道访问；Grafana 已改强密码。

## 3. 计费 / 额度（手动确认）

- [ ] `REELYAI_SESSION_GENERATION_DAILY_CAP` 设为与预算匹配的值（默认 200）。
- [ ] 确认 Agent Plan vs 标准 Key 归属：Seedream/Seedance 走哪条计费链路符合预期（`REELYAI_USE_AGENT_PLAN`、各 `*_AGENT_PLAN_MODEL`）。
- [ ] Vision 复审 + poll 自动重提的放大成本可接受；`maxReviewAttempts` 在预期范围。
- [ ] TOS 上传产生的存储/出站费用已知悉；`TOS_*` 配置正确。
- [ ] **真实账单对账**：发布后用火山引擎账单核对一次实际消耗。`reelyai_token_usage_total` 等指标仅供观测，**不等于**账单金额。

## 4. 发布后线上验证

```bash
REELYAI_BASE_URL=https://<public-url> REELYAI_ACCESS_TOKEN=<token> npm run smoke:production
```

- [ ] `smoke:production` 全绿（healthz / readyz / 安全态 / state）。
- [ ] Grafana「ReelyAI 总览」看板有数据；`up{job="reelyai"} == 1`。
- [ ] 手动触发一条测试告警，确认能落到飞书群（见 `deploy/observability.md`）。
- [ ] `reelyai_component_up` 各组件为 1；如有降级（如 TOS/Seedance 未配）已知悉。

## 5. 回滚预案

- [ ] 记录本次部署的 commit；如线上异常，重新对上一个 commit 跑 `deploy.yml` 即可回滚（rsync + 远程 rebuild）。
- [ ] `reelyai-data` volume 为单文件 JSON store；回滚前如有数据结构变更需评估兼容性。
