# ReelyAI：VLM 反馈与 Prompt 自动优化体系设计

## 1. 背景与目标

ReelyAI 已具备基础 VLM 审图、审片与 prompt 修复能力：图片生成可通过 `withImageReview` 自动审核与重试；视频生成在 Seedance 轮询成功后可触发 VLM 审片，失败时改写 prompt 后重提任务；完整片也支持终审与修复建议。

当前问题是能力分散：图片闭环、视频闭环、终审修复、资产修复、参考视频分析分别散落在不同路由和函数中，缺少统一数据模型、评分标准、健康看板和自动优化策略。

目标：把 VLM 从“事后质检工具”升级为“生成闭环控制器”：

- 生成前：检查 prompt 与参考资产是否明确。
- 生成中：每次产物用 VLM 自动审查。
- 生成后：将 VLM 反馈结构化落库。
- 修复时：定位问题来自 prompt、资产、参考图、模式冲突、镜头连续性还是模型能力。
- 重试时：自动生成更好的 prompt，并保留 before/after 审计。
- UI 上：在画布与 Inspector 显示节点健康状态、失败原因与建议动作。

## 2. 当前已有能力

### 2.1 审图能力

核心文件：`src/server/visionReview.ts`

已有能力：

- `reviewImage` / `reviewImageDetailed`
- 支持 asset / sketch 两类图片审核
- 输入：原 prompt、产物图、最多 3 张参考图
- 输出：`ImageReviewVerdict`
- 字段：`ok`、`score`、`criteria`、`fatalIssues`、`reasons`、`fixes`
- 默认通过条件：score >= 75 且无 fatal issue

已接入路径：

- `POST /api/assets/:assetId/review`
- `POST /api/assets/:assetId/generate`
- `POST /api/shots/:shotId/sketches`

### 2.2 审片能力

核心文件：`src/server/visionReview.ts`

已有能力：

- `reviewVideo` / `reviewVideoDetailed`
- ffmpeg 均匀抽帧
- 支持 shot 审核和 final video 终审
- 输出：`VideoReviewVerdict`
- 字段：`ok`、`score`、`criteria`、`fatalIssues`、`reasons`、`fixes`、`frameEvidence`

已接入路径：

- `POST /api/shots/:shotId/review`
- `POST /api/sessions/:sessionId/final-review`
- `POST /api/shots/:shotId/poll` 中的生成后自动审片与重试

### 2.3 Prompt 自动改写

核心函数：`rewritePromptWithReviewFeedback`

已有能力：

- 接收原 prompt、VLM reasons、参考图、失败产物图
- 使用文本/视觉模型改写 prompt
- 失败时不抛错，自动回退原 prompt
- 支持中英文

当前使用方式：

- 图片：`withImageReview` 中失败后改写 prompt 再重生
- 视频：`poll` 中 Seedance 成功后，如果 VLM 未通过，则改写 prompt 并重提 Seedance
- 手动修复：`/review/repair-prompts` 把修复块 append 到原 prompt 后面

## 3. 当前问题与缺口

1. **审核逻辑分散**：图片有 `withImageReview`，视频自动审核重试逻辑写在 `/api/shots/:shotId/poll` 中。
2. **评分维度不稳定**：criteria 由 VLM 自由生成，不利于跨镜头统计。
3. **Prompt 修复偏追加**：`appendRepairBlock` 会让 prompt 越来越长，旧错误表达仍然存在。
4. **缺少归因**：系统没有稳定判断问题来自 prompt、资产、参考图、模式冲突还是模型能力。
5. **缺少统一健康看板**：review trail 分散在各节点，没有 session 级健康视图。
6. **帧抽取策略固定**：均匀采样对快速动作镜头代表性不足。

## 4. 目标体系总览

建议拆成 5 层：

1. **Review Layer：统一审核层**
2. **Diagnosis Layer：问题归因层**
3. **Repair Layer：Prompt / 资产修复层**
4. **Retry Layer：自动重试层**
5. **UX Layer：画布健康状态与人工接管层**

闭环：

```text
生成请求
  ↓
模型产物（图片 / 视频 / 完整片）
  ↓
VLM Review
  ↓
结构化 Verdict
  ↓
Diagnosis 归因
  ↓
Repair Plan
  ↓
Prompt Rewrite / Asset Regenerate / Mode Fix
  ↓
Retry Generate
  ↓
再次 Review
  ↓
通过 / 失败进入人工接管
```

## 5. 统一数据模型

### 5.1 ReviewVerdictBase

```ts
interface ReviewVerdictBase {
  scope: 'asset' | 'sketch' | 'shot' | 'session_final';
  ok: boolean;
  score: number;
  criteria: ReviewCriterionScore[];
  fatalIssues: string[];
  reasons: string[];
  fixes: ReviewFix[];
  diagnosis?: ReviewDiagnosis[];
  model: string;
  reviewedAt: string;
  rawText?: string;
}
```

### 5.2 固定评分维度

#### 图片资产

| key | 权重 | 含义 |
|---|---:|---|
| prompt_alignment | 0.20 | 是否符合文字描述 |
| subject_integrity | 0.20 | 主体结构是否完整，脸/手/物体是否正常 |
| photoreal_quality | 0.20 | 是否真实、清晰、无糊脸/塑料感 |
| reference_consistency | 0.20 | 是否遵守参考图身份/服装/构图 |
| production_usability | 0.20 | 是否适合作为后续视频参考底板 |

#### 视频 Shot

| key | 权重 | 含义 |
|---|---:|---|
| prompt_alignment | 0.20 | 是否符合 shot prompt |
| character_continuity | 0.20 | 角色身份/服装/年龄是否稳定 |
| motion_quality | 0.20 | 动作是否自然，是否有跳变/畸变 |
| composition_lighting | 0.15 | 镜头、构图、光线是否可用 |
| artifact_control | 0.15 | 是否有闪烁、糊脸、肢体错误、字幕水印 |
| transition_continuity | 0.10 | 与前后镜头或首尾帧是否连贯 |

#### 完整片终审

| key | 权重 | 含义 |
|---|---:|---|
| story_coherence | 0.20 | 叙事是否连贯 |
| shot_order_continuity | 0.20 | 镜头之间是否衔接自然 |
| character_consistency | 0.20 | 角色跨镜是否稳定 |
| audiovisual_quality | 0.15 | 视频/音频/字幕整体质量 |
| pacing | 0.15 | 节奏是否合理 |
| fatal_artifacts | 0.10 | 是否有不可接受瑕疵 |

## 6. Review Layer：统一审核层

### 6.1 增强 `withImageReview`

保留现有机制，但增强：

- criteria 使用固定 schema
- 每次 attempt 保存结构化 review trail
- review trail 不只写自然语言 `reviewNote`

### 6.2 新增 `withVideoReview`

对标 `withImageReview`，从 poll 路由中抽离：

```ts
withVideoReview({
  enabled,
  maxAttempts,
  kind: 'shot',
  prompt,
  referenceUrls,
  generate,
  review,
  rewritePrompt
})
```

职责：

- 调用 generate 生成视频
- 调用 `reviewVideoDetailed` 审核
- 未通过则调用 `rewritePromptWithReviewFeedback`
- 重试直到通过或达到上限
- 返回最终视频、attempt trail、最后 verdict、rewritten prompt

收益：

- 图片/视频闭环一致
- poll route 变薄
- 后续可用于批量重生、自动修复、CI 检查

## 7. Diagnosis Layer：问题归因层

VLM reasons 应转成机器可执行的 diagnosis。

### 7.1 诊断类型

```ts
type DiagnosisKind =
  | 'prompt_missing_detail'
  | 'prompt_conflict'
  | 'asset_quality_bad'
  | 'asset_identity_mismatch'
  | 'reference_url_broken'
  | 'mode_conflict'
  | 'first_frame_mismatch'
  | 'last_frame_mismatch'
  | 'character_drift'
  | 'motion_artifact'
  | 'composition_error'
  | 'model_limitation';
```

### 7.2 归因规则示例

| VLM 反馈 | 归因 | 建议动作 |
|---|---|---|
| 脸糊、不是真人 | asset_quality_bad | 重生角色资产，增强 photoreal prompt |
| 角色衣服变了 | character_drift | 强化角色参考，锁定服装描述 |
| 首帧没有接上 | first_frame_mismatch | 检查 firstFrameAssetId，重抽尾帧 |
| 画面有字幕/水印 | artifact_control | prompt 加 strict negative，重生 |
| 分镜顺序错乱 | prompt_conflict | 用 sequential storyboard，每格单独生成再拼接 |
| 参考图 403 | reference_url_broken | 重新 publish TOS |
| 同时用了 first_frame 和 reference_image | mode_conflict | UI 强制互斥，清理字段 |

## 8. Repair Layer：修复层

### 8.1 Prompt clean rewrite

建议从 append 模式升级到 clean rewrite：

```text
旧：原 prompt + 【VLM 修复块】
新：生成一份完整替代 prompt，并保留 before/after diff
```

落库：

```ts
interface PromptRepairRecord {
  id: string;
  targetKind: 'shot' | 'asset' | 'storyboard';
  targetId: string;
  sourceVerdictId: string;
  beforePrompt: string;
  afterPrompt: string;
  reasons: string[];
  model: string;
  createdAt: string;
  appliedAt?: string;
}
```

### 8.2 不同对象的修复策略

- **角色资产**：强化真人照片级、年龄、发型、服装、清晰脸部、非 3D negative。
- **场景资产**：强化无人物、空间布局、光线、材质。
- **分镜板**：若格子合并/漏格，自动切 sequential 模式，单格生成后 ffmpeg 拼接。
- **视频 Shot**：修动作、构图、角色一致性；衔接问题优先建议尾帧 node / first_frame 模式。
- **完整片**：按 `fixes.shot` 定位具体 shot，生成 repair plan。

## 9. Retry Layer：自动重试策略

### 9.1 默认重试上限

| 类型 | 默认尝试 | 最大尝试 |
|---|---:|---:|
| asset image | 2 | 5 |
| sketch/storyboard | 2 | 5 |
| shot video | 1 | 3 |
| final video | 不自动重生 | 人工确认 |

### 9.2 停止条件

立即停止并要求人工接管：

- 连续两次同一 fatal issue
- 参考 URL 失效
- prompt rewrite 后变长超过阈值
- VLM 判定为 model limitation
- 生成成本超过 session 预算

### 9.3 重试策略

```text
attempt 1：原 prompt
attempt 2：clean rewrite prompt
attempt 3：改变生成模式（如 storyboard composite → sequential）
attempt 4：请求用户换资产/首尾帧/参考视频
```

## 10. UX 设计

### 10.1 Canvas 节点健康状态

每个节点显示：

- VLM 未审
- VLM 通过
- VLM 需修
- VLM 审核中
- VLM 已过期

颜色：

- 灰：未审
- 绿：通过
- 黄：可修
- 红：严重失败
- 蓝：审核中

### 10.2 Inspector 审核面板

统一 section：

```text
VLM 反馈
Score: 72 / 100
主要问题：
- 角色脸部模糊
- 与参考图服装不一致
建议动作：
[自动修 Prompt]
[重生]
[查看 before/after]
[标记接受]
```

### 10.3 Session Review Dashboard

新增 `Review Health` 面板：

```text
Session 健康度：78

资产：
- 老板：需修，脸糊
- 办公室：通过

分镜：
- Shot 1：通过
- Shot 2：需修，动作漂移
- Shot 3：未审

完整片：
- 未终审
```

### 10.4 首尾帧 / 参考图模式提示

视频节点需要明确显示当前模式：

- 默认参考图/参考视频模式
- 首帧模式
- 首尾帧模式
- 子分镜板模式
- 参考视频模式

UI 需要强制互斥，避免 Seedance payload 混入不兼容内容。

## 11. API 设计

### 11.1 Review Health

```http
GET /api/sessions/:sessionId/review-health
```

返回：

```ts
interface SessionReviewHealth {
  score: number;
  assets: NodeReviewHealth[];
  shots: NodeReviewHealth[];
  storyboards: NodeReviewHealth[];
  final?: NodeReviewHealth;
}
```

### 11.2 Repair Preview

```http
POST /api/review/repair-preview
```

只生成 before/after prompt，不立即应用。

### 11.3 Apply Repair

```http
POST /api/review/repair-apply
```

应用选中的 prompt rewrite。

### 11.4 Batch Review

```http
POST /api/sessions/:sessionId/review-all
```

按顺序审核所有 ready 节点。

## 12. 实施阶段

1. 统一评分与记录
2. 抽象 `withVideoReview`
3. Prompt Repair Preview
4. Session Review Dashboard
5. 高级诊断：运动感知抽帧、相邻镜头 continuity、尾帧/首帧建议、成本预算

## 13. 关键原则

1. VLM 反馈必须结构化。
2. Prompt 修复优先 clean rewrite。
3. 每次自动优化必须可审计。
4. 自动重试必须有上限。
5. 模式互斥必须前置到 UI。
6. 资产质量是视频质量的上游。
7. 用户始终可接管。

## 14. 总结

这套体系的核心不是“多加一个 VLM 审核按钮”，而是把 VLM 变成 ReelyAI 的生产闭环控制器：读产物、判断问题、定位原因、改写 prompt、驱动重试，并把状态呈现在画布上。
