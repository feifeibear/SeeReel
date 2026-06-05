# Playbook — cockpit-POV 60s 一镜到底（基于 ses_0a7c9292）

实战记录：用 seereel-agent 把 6 段 × 10s 的虚构沙漠演习靶场短片串成一条 60s、9:16 竖屏、cockpit POV 一镜到底。本文沉淀 API 调用顺序、关键参数和踩到的坑。所有曲目均跑在 standard 档 doubao-seedance-2-0，质量优先。

## 端到端流水线

| 步骤 | API | 关键参数 | 备注 |
| --- | --- | --- | --- |
| 1 | `PATCH /api/sessions/:id` | `title` / `logline` / `style` / `language="zh"` / `targetDurationSec=60` | `style` 字段是 freeform，把 9:16 / 仪表盘锚定 / "no real-world cities" 这类硬规则写进去，让后面所有 prompt 自动继承。 |
| 2 | `PATCH /api/shots/:id` × N | `title` / `prompt` / `rawPrompt` / `camera` / `durationSec` / `seedanceVariant` | `prompt` 用 "硬规则块 + 本段细节" 两段拼接结构，保证每个 shot 都带同一份长视频一致性约束（仪表盘锚定、统一色调、TARGET-LEAD-01 始终在前等）。 |
| 3 | `POST /api/assets`（×3） + `POST /api/assets/:id/generate` | `model="seedream-4-5"` / `visionReview=true` / `maxReviewAttempts=6` | 三个 anchor：style（cockpit POV 风格基准）/ scene（靶场全貌）/ character（领航无人僚机 TARGET-LEAD-01）。VLM 自审挂在这条接口，6 次封顶；过审保留最后一次产物。 |
| 4 | `POST /api/shots/:id/sub-storyboard` × N | `panelCount=4` / `layout="2x2"` / `size="1664x2944"` / `mode="composite"` / `referenceAssetIds=[style,scene,character]` | **size 必须 ≥ 3.69MP**，1152x2048 会被 Seedream 4.5 拒（`InvalidParameter: image size must be at least 3686400 pixels`）。9:16 portrait 推荐 `1664x2944` ≈ 4.9MP。 |
| 5 | `POST /api/shots/:id/generate` × N | body `{}` 即可；自动进入 sub-shot 模式 | shot 上 `subShotStoryboardAssetId + subShotPanelCount > 1` 一旦被设置，submitShotGeneration 自动用 sub-shot mode（grid + "Follow the storyboard sequence" 指令），并禁用 first-frame I2V。 |
| 6 | `POST /api/shots/:id/poll` | 客户端轮询，没有后台 worker | 每 25-30s 一次。VLM 自审会在 Seedance 完成后自动起一次复检并按需 resubmit Seedance（看 `[vision-review]` 日志），所以总耗时 = 首轮 Seedance + 可能的复检重试。 |
| 7 | `POST /api/sessions/:id/stitch` + `/stitch/poll` | 无；后台 ffmpeg | concat libx264 preset=medium crf=18，60s 通常 5-10s 完成。 |

## 模式互斥矩阵

`submitShotGeneration` 里有一组优先级严格的模式分发逻辑，理解清楚就不会再 patch 了别的字段没生效：

```
useSubShotMode  > useReferenceVideoMode > useFirstFrameMode > usePreviousShotClip > 纯 prompt
```

* sub-shot mode：`subShotStoryboardAssetId` + `subShotPanelCount > 1` 触发，把 grid 当成 reference_image 喂给 Seedance + 序列指令。
* first-frame mode：`firstFrameAssetId` 触发；和 sub-shot 互斥（grid 优先）。
* reference-video mode：`referenceVideoAssetId`，把用户自有/授权参考视频作为 Seedance reference_video 输入。
* previous-shot continuity：`usePreviousShotClip=true`，把上一段的尾巴当 reference_video。

要让一个 shot 走纯 prompt（这次踩坑就是用这条救 S1），需要把以上字段全清掉：
```bash
curl -X PATCH /api/shots/$ID -d '{
  "subShotStoryboardAssetId": null,
  "subShotStoryboardAssetIds": [],
  "subShotPanelCount": 0,
  "renders": [],
  "videoUrl": null,
  "status": "scripted"
}'
```

## 已知陷阱

### Sub-storyboard layout 不是硬约束
`layout: "2x2"` 在 `composeSeedreamSubStoryboardGrid` 里只是 prompt 文字提示，Seedream 4.5 会自由发挥。这次 6 个 grid 里 S2/S3 出了 1x4 stacked、S5 出了 1x3、S1/S4/S6 才是 2x2。每格内容都对，但视觉布局漂。要严格 2x2 用 `mode: "sequential"`（每格单独生成 + 本地 ffmpeg 拼）。

### Seedance 把 storyboard 直接当成视频帧
**最严重的踩坑**。S1 的 grid 带很重的 filmstrip 边框，Seedance 一镜到底就把整张 grid 当画面渲染成视频，4 个 panel + 胶片孔 全程在屏幕上。负面 prompt（`不要把输出渲染成网格；不要在输出视频中出现面板边框或标号`）没起作用。

修复路径：
1. **首选**——把 sub-storyboard 的 prompt 里"filmstrip / 胶片 / sprocket"这类词全部 ban 掉（Seedream 4.5 在 panelCount=4 / layout=2x2 时容易自带 filmstrip 风格）。
2. **次选**——清掉 shot 的 sub-shot 字段走 prompt-only（这次救 S1 用了这条）。
3. **再次**——shot prompt 里加一条 `输出必须是单一连续画面，不能是 storyboard / 网格 / 胶片 / 多面板`。

### Seedream 4.5 size 下限
`image size must be at least 3686400 pixels`。常用 9:16 portrait 安全选项：

| size | 像素 | 备注 |
| --- | --- | --- |
| `1664x2944` | 4.9 MP | 推荐，约 9:15.92 |
| `1536x2730` | 4.2 MP | 9:16 精确 |
| `1440x2560` | 3.69 MP | 卡线，偶尔被拒 |
| `1152x2048` | 2.36 MP | **拒** |

### VLM 自审的过严倾向
本次 anchor 跑了 5/6 次都不过审（被判"动漫手绘 / 类人机器人 / 塑料人偶质感"），但 review 保留了最后一次产物，下载下来肉眼看其实是 photorealistic CGI、可用。建议：
- VLM 用作筛选不是阻断，URL 拿到先肉眼过一眼。
- review 失败后通过 `reviewNote` / `reviewModel` 字段读取理由，针对性改 asset.prompt 再 trigger 一次 generate（asset id 不变）。

### Sub-shot mode 触发 VLM 自动重试
shot Seedance 完成后会自动跑一次 vision-review。这次 6 段里 S1/S2/S3/S6 头一轮都没过，自动 resubmit 了第二轮 Seedance（占用了额外 5-7 分钟）。S4/S5 头一轮就过。表现在日志里就是：
```
[vision-review] shot shot_xxx render render_yyy attempt N/5 failed; resubmitted as task cgt-...
```

## 实测时间线（standard 档）

| 阶段 | 耗时 |
| --- | --- |
| Anchor × 3（含 VLM 各 ≤5 轮重试） | ~3-5 分钟（并发） |
| Sub-storyboard × 6（合成模式，含 VLM 一次） | ~50s 每条，并发 ~50s |
| Seedance × 6（含部分二轮 VLM 重试） | ~26 分钟（并发，最长一条决定） |
| Stitch ffmpeg | 6 秒 |
| **总计** | **~30-35 分钟** 拿到一条 60s 9:16 一镜到底 |

## 视频质量观感

| Shot | 评级 | 备注 |
| --- | --- | --- |
| S1 跑道起飞 | 良（v2） | 第一轮失败（grid-as-video，胶片孔+四宫格挂全程）→ 清掉 sub-shot 字段、prompt-only 重做后变成全屏座舱 + HUD + 跑道；第二段未真正脱地，但跨段连贯性靠后面 5 段拉起来 |
| S2 爬升+TARGET-A | 优 | 全屏座舱，TARGET-LEAD-01 / 仪表盘 / 9:16 都对位 |
| S3 贴飞 TARGET-A | 优 | HUD 锁定框 + A/B 双塔 + 远景 |
| S4 缓滚 | 良 | Seedance 退化为平直巡航，没真正翻滚 |
| S5 改平 + 双靶塔阵 | 良 | 翻滚画面有，但仪表盘没完美锚定（跟着翻了） |
| S6 锁定→导弹→命中 | 优 | 锁定框 / 弹道 / 爆破 / 完成勾选 全齐 |

## v3 — first-frame chain 真正的一镜到底

之前的 v2 各段相互独立、靠风格相似性蒙混；切点能看出"画面对，但运镜从头开始"的跳切感。v3 改成**段间用上一段实拍末帧锁定下一段首帧**，做出物理意义上的一镜到底。

### Seedance 端的硬约束（实测）

`dreamina-seedance-2-0-260128` 拒绝把 `first_frame` / `last_frame` 与 `reference_image` / `reference_video` 混进同一个 `content[]`：

```
InvalidParameter: first/last frame content cannot be mixed with reference media content
```

所以 sub-shot grid（作为 reference_image）和 first-frame I2V **不能并存于一次生成调用**。早先以为是 server 层的人为互斥，实测是 Seedance API 本身的合约。要做一镜到底，shot N+1 拿到 firstFrame 时必须放弃 sub-shot grid。

### server 层的 mutex 翻转

cinema_agent 原本是 `sub-shot > first-frame`（grid 优先），意味着用户 wire firstFrame 不会生效。v3 把优先级翻成 `first-frame > sub-shot`，wire firstFrame 自动让 grid 让位本次生成（grid 字段保留在 shot 上，清掉 firstFrame 时还能恢复）。改动落在三个地方，每处都把"sub-shot active"这个布尔从"grid 字段齐全"改成"grid 字段齐全 **且** 没有 firstFrame"：

- `src/server/generators.ts buildBytePlusSeedancePayload`（~line 965）
- `src/server/index.ts submitShotGeneration`（~line 2776）
- `src/server/index.ts dryRunSeedanceComposition`（~line 2649）

`composeSeedanceVideoText`（promptCompose.ts）保持 else-if 链不变 —— payload 既然只能选一个 mode，prompt 文案也对应只发一段。

### tailframe 路由扩展 publishToTos

为了 chain 的人体工学，`POST /api/shots/:id/tailframe` 加了 `{ "publishToTos": true }` 选项。一次调用做完 ffmpeg 抽末帧 + 上传 TOS，返回的 asset 直接带 https url，可立即赋给下一段的 `firstFrameAssetId`。

### tailframe ffmpeg 远程 URL 兼容

ffmpeg 抽帧时如果 video 来自 https TOS，旧路径用 Node 的 `fetch + writeFile + ffmpeg -sseof` 三步走。问题：`@ffmpeg-installer/ffmpeg` 是 v4.x，**不支持负向 `-sseof` 在 HTTP 输入上 seek**，会"成功"产生 0 字节输出。修复：
- 改成把 https URL 直接交给 ffmpeg（它自己支持 HTTP/HTTPS）
- 改用 ffprobe 拿时长、再用正向 `-ss <duration-0.1>`（forward-seek 在 HTTP Range 上完全可靠）
- 加输出文件存在 + 大小 > 0 的 sanity check，防止 asset row 指向不存在的文件

### chain 工作流（每段重复）

```bash
# 1. 抽前一段末帧 + 上传 TOS
ASSET=$(curl -X POST /api/shots/$PREV/tailframe -d '{"publishToTos":true}' | jq -r .asset.id)

# 2. 把 firstFrame wire 到下一段，清旧 render
curl -X PATCH /api/shots/$NEXT -d "{\"firstFrameAssetId\":\"$ASSET\",\"renders\":[],\"videoUrl\":null,\"status\":\"scripted\"}"

# 3. 重新提交 + 轮询
curl -X POST /api/shots/$NEXT/generate -d '{}'
# poll until videoUrl != null
```

S1 不需要 first-frame（链头），S2-S6 每段从前一段实拍末帧起步。注意：本设计**只能串行**，不能并行 chain，因为下一段依赖前一段的 `videoUrl`。

### v3 实测时间线

| 段 | 状态 | 备注 |
|---|---|---|
| S1 | ready（v2 沿用，prompt-only） | 链头，不需 firstFrame |
| S2 | ready（~9 min，VLM 一次过） | firstFrame=S1 末帧 |
| S3 | ready（~28 min，VLM 自动 resubmit 一次） | firstFrame=S2 末帧 |
| S4 | ready（~26 min，第一次提交瞬态 45s 超时，自动重试通过） | firstFrame=S3 末帧 |
| S5 | ready（~26 min，VLM 自动 resubmit 一次） | firstFrame=S4 末帧 |
| S6 | ready（~26 min，VLM 自动 resubmit 一次） | firstFrame=S5 末帧 |
| Stitch | ~6s | ffmpeg concat |

总耗时约 2 小时（Seedance 串行 + VLM 重试）。比 v2 慢约 4 倍，但是真正一镜到底。

### v3 切点验证

肉眼对比 t=10s/20s/30s/40s/50s 的相邻帧（S_n 末帧 vs S_n+1 首帧）：

- S1→S2：runway → 空中爬升，仪表盘 / HUD / 色调完全一致 ✓
- S2→S3：低空巡航延续，TARGET-LEAD-01 在 HUD 左上 ✓
- S3→S4：开始向滚转过渡 ✓
- **S4→S5：完美继承翻转状态**（天空在画面下方、沙地在上方），仪表盘锚定在飞机自身坐标系 ✓
- S5→S6：HUD 中心绿色锁框→红色锁定，跨段动作连贯 ✓

成片 v3：`/media/final-ses_0a7c9292-be2715aa5c94.mp4`，720x1280, 60.6s。

### 关键洞见

1. **真正的"一镜到底"= 段间末帧→首帧物理锁定**，仅靠 prompt 风格描述不够。
2. **Seedance 模式互斥不是 cinema_agent 设计偏见，是 API 合约**。要做 chain，sub-shot grid 必须为 first-frame 让位。
3. **VLM 自动复检在 chain 流程下会大幅拖长总耗时**（每次失败 + 重试 ≈ 多一轮 Seedance）。在你已经手动审过 prompt 的场景下，可以考虑通过 `visionReview: false` body 关掉。
4. **bundled `@ffmpeg-installer/ffmpeg` v4.x 在远程 HTTP 输入上不支持负向 `-sseof`**。任何长视频后处理路径都要小心这点。
