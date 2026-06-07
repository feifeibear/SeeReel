---
name: seereel-canvas-review
description: Use when a user gives an initial short-drama idea and wants SeeReel to expand it into a reviewable canvas with script, characters, scenes, storyboard, shot prompts, and reference links before video generation.
---

# SeeReel Canvas Review

## Purpose

Turn a rough idea into a review-first canvas. The output is a visible SeeReel session containing the detailed script layer, character assets, scene assets, storyboard planning, shot nodes, prompts, and reference wiring. Do not generate video in this stage.

Use this as the default intake skill when the human asks for 剧本完善, 角色, 场景, 故事板, 分镜, 分镜 prompt, 引用什么角色/场景, or “先在 canvas 上建出来给人审”.

## Core Boundary

- Do not generate video, render, poll Seedance tasks, stitch, download final video, or spend paid/quota-consuming video credits.
- Stop after the canvas is ready for human approval.
- Continue into render only when the human explicitly approves the reviewed canvas.
- Treat manual web edits as source of truth. If the human edits the board, refresh status before patching or continuing.
- Keep all creative decisions in SeeReel state, not private notes.
- Default to autonomous drafting. Ask the human questions only in **Interactive Mode** or when a hard constraint cannot be safely inferred.

## Composition With Other Skills

- Use `seereel-script-chat` for story spine, character functions, dialogue packets, audienceDelivery, beat ladder, and StoryPlan shape.
- Use `seereel-storyboard-imagegen` for per-shot 3x3 storyboard prompt language.
- Use `seereel-agent-session` or `seereel-cli` for creating and patching the visible session, assets, and shots.
- Use this skill's Script Review Loop after the first draft and before final canvas handoff.

## Intake

Start with the user's idea. If the user explicitly says `交互模式`, asks to discuss, or invites questions, enter **Interactive Mode** and ask at most two high-leverage questions when the answer materially changes the canvas:

- target duration or shot count
- tone/style or reference film
- must-have characters, locations, props, or ending

If the user does not explicitly request discussion, otherwise work autonomously: make reasonable assumptions, research the premise, draft the canvas, review it, revise it, and only report the final review-ready session.

If details are missing, choose conservative defaults:

- language: Chinese unless the user writes in English
- duration: 60s
- shot count: `Math.ceil(targetDurationSec / 15)`, clamped to 3-8 for ordinary short dramas
- style: grounded cinematic realism, no subtitles, no watermark, no readable text overlays

Prefer 15-second Seedance shots when building the canvas. Put multiple beats inside one shot when they share the same characters, location, emotional continuity, and camera space; use internal 0-4s / 4-9s / 9-13s / 13-15s action beats. The default is not one short shot per beat. Longer in-shot continuity usually preserves faces, wardrobe, lighting, and scene layout better than stitching many short clips.

## Research Pass

Before writing the first script draft, search for material connected to the idea's characters, plot, and historical background. Use web search, local project memory, user-provided references, or reliable primary/secondary sources as appropriate.

Collect enough research to make the story specific:

- character models: real roles, jobs, social classes, speech habits, motivations, status conflicts
- plot mechanisms: scams, technologies, rituals, institutions, business models, anxieties, incentives
- historical background: dates, places, material culture, clothing, architecture, tools, laws, transport, media, prices, and anachronism traps
- scene texture: props, room layout, street details, crowd behavior, ambient sound, signs that should not become readable subtitles

Save a short visible research packet in the session `StoryPlan` notes, synopsis, or tone field. Cite or summarize the sources and record how each source changes the script, character assets, scene assets, or shot prompts. Do not dump private notes that the user cannot inspect.

For historical or factual premises, do not write generic period flavor first. Research first, then draft.

## Script Review Loop

After writing the first script draft, run a review pass before creating final shot prompts. Review as a skeptical story editor, not as the same writer defending the draft.

Check:

- premise clarity: the title promise is answered by the ending
- orientation: by the first 10 seconds a cold viewer can answer who/where/when/world-rule/relationship/stakes without reading the prompt
- first appearance: every main character has identityDelivery through action, dialogue, voiceover, prop behavior, or a motivated establishing/master shot
- research use: character behavior, plot mechanism, and historical background are specific and not generic
- dramatic motion: every shot changes story state
- pacing: duration matches content density; no shot carries too much exposition
- 15s packing: related micro-beats are grouped into full 15s Seedance shots where possible, not one short shot per beat
- continuity: characters, scenes, props, and visual style remain stable
- prompt safety: no subtitles, no readable text dependence, one dialogue language, diegetic sound only, no per-shot music
- audience comprehension: important prompt information is delivered through voiceover or character dialogue, with visible action/reaction backup; prompt-only lore, subtitles, readable signs, UI text, captions, and text overlays do not count unless explicitly requested
- generation readiness: each shot names referenced character/scene/storyboard assets through `assetIds`

Run at least two review passes for a new script idea. After each pass, patch the `StoryPlan`, characters, scenes, shot scripts, prompts, and `assetIds` that the review flags. Continue until the reviewer is satisfied or until five passes produce no material improvement. If still unsatisfied after five passes, stop and surface the remaining blockers instead of generating video.

Store the final review summary in the handoff notes so the human can see what changed.

## Canvas Readiness Contract

Before handoff, the canvas must contain:

1. A session with title, logline, style, target duration, and shot count.
2. A saved `StoryPlan` with premise, synopsis, theme, tone, research packet, characters, beats, audienceDelivery, dialogue intent, review notes, and locked review status.
3. Character assets for every recurring role. Use prompt-only placeholders when image generation is not needed yet.
4. Scene assets for recurring locations or production-design anchors. Tag them as `scene assets`.
5. Shot nodes for every major beat group, each with title, duration, script/action, `rawPrompt`, `prompt`, and status no later than `scripted` or `draft`. Prefer 15-second Seedance shots with multiple beats inside one shot instead of one short shot per beat.
6. Explicit shot-to-reference links: set `assetIds` for the character assets, scene assets, props, and storyboard references each shot needs.
7. A storyboard prompt for every shot, preferably in the `seereel-storyboard-imagegen` 3x3 contact-sheet format.
8. A human review checklist describing what to inspect before approving video generation.

## Build Flow

### 1. Create Or Select Session

Prefer the CLI for a fast reviewable skeleton:

```bash
seereelcli workflow "用户初步想法" --duration 60 --json
```

Do not pass `--render`, `--stitch`, or `--generate-storyboards` unless the user explicitly asks for that extra step. Return the `handoffUrl` for browser review; raw `webUrl` may belong to the CLI cookie identity.

API fallback:

```text
GET /api/state
POST /api/sessions
PATCH /api/sessions/:sessionId
```

### 2. Write The StoryPlan

Convert the researched idea into a concrete script layer:

```json
{
  "premise": "一句话前提",
  "synopsis": "完整短片梗概",
  "theme": "主题或喜剧机制；调研得到的真实矛盾或历史压力",
  "tone": "影像风格、节奏、禁忌项；Research: 资料摘要、来源、对角色/情节/历史背景/分镜的影响；Review: 第几轮审阅、发现的问题、已修复项",
  "characters": [
    {
      "name": "角色名",
      "role": "身份和戏剧功能",
      "arc": "开场状态 -> 变化 -> 结尾状态",
      "identityDelivery": "首次出场时观众如何知道 ta 是谁、背景是什么、和谁存在关系/压力；不要只靠 asset 名称或 prompt 私货",
      "assetId": "asset_xxx",
      "assetMention": "@角色名"
    }
  ],
  "beats": [
    {
      "index": 1,
      "title": "分镜标题",
      "purpose": "本分镜叙事目的",
      "plot": "画面中发生的动作和自然表演的台词意图；no subtitles。",
      "orientationPacket": {
        "who": "首次出现或本场关键角色的身份/状态/关系",
        "where": "场景空间、入口出口、权力位置、关键界面或道具",
        "when": "时代、时间、技术规则或社会背景",
        "worldRule": "观众现在必须知道的世界规则",
        "stakes": "这一刻为什么重要"
      },
      "audienceDelivery": [
        {
          "fact": "观众必须理解的关键信息",
          "mode": "character dialogue | voiceover | overheard line | argument | question-answer",
          "line": "同一对白语言中的一句短台词或旁白",
          "visualBackup": "同时发生的可见动作、道具、表情或反应"
        }
      ],
      "emotion": "情绪变化",
      "visual": "场景、构图、镜头、光线、动作调度；15s shot 内部 0-4s / 4-9s / 9-13s / 13-15s 多个 micro-beats",
      "assetMentions": ["@角色名", "@场景名"],
      "durationSec": 15
    }
  ],
  "locked": true,
  "model": "canvas-review"
}
```

Save it through:

```text
PATCH /api/sessions/:sessionId/script
```

Run the Script Review Loop here. Do not move on to final shot prompts until the review is satisfied.

### 3. Create Character And Scene Assets

Create or reuse assets before patching shot references.

Character asset pattern:

```json
{
  "name": "角色名",
  "type": "character",
  "mediaKind": "none",
  "description": "【角色资产】身份、年龄、外观、服装、气质、表演功能、跨分镜一致性。",
  "prompt": "Character reference prompt: face identity, wardrobe, posture, story function, cinematic realism.",
  "tags": ["cast", "canvas-review", "character assets", "角色名"],
  "ownerSessionId": "session id"
}
```

Scene asset pattern:

```json
{
  "name": "场景名",
  "type": "reference",
  "mediaKind": "none",
  "description": "【场景资产】地点、时间、光线、空间关系、关键道具、不可漂移的视觉锚点。",
  "prompt": "Scene reference prompt: production design, layout, lighting, weather, props, cinematic realism.",
  "tags": ["scene", "canvas-review", "scene assets", "场景名"],
  "ownerSessionId": "session id"
}
```

Use:

```text
POST /api/assets
PATCH /api/assets/:assetId
```

Do not call `POST /api/assets/:assetId/generate` unless the human asks to create actual reference images before review.

### 4. Generate And Patch Shot Nodes

Use:

```text
POST /api/sessions/:sessionId/storyboard
PATCH /api/shots/:shotId
```

Patch every shot so the Inspector is audit-ready:

```json
{
  "title": "01 标题",
  "durationSec": 15,
  "script": "15s 内的动作、调度、自然表演的台词意图；audienceDelivery 中的关键信息要通过人物对白或旁白说出来，并有可见动作/反应兜底；可包含多个相关 micro-beats。",
  "rawPrompt": "短片名；分镜编号；动作；audienceDelivery：关键信息通过 voiceover or character dialogue 传达；@角色名；@场景名；摄影、光线、连续性；no subtitles, no watermark, no logo, no readable text。",
  "prompt": "扩写后的 Seedance prompt，但仍然只保存不提交。",
  "assetIds": ["asset_character", "asset_scene"]
}
```

Prompt requirements:

- State which characters and scenes are referenced.
- Include camera, light, blocking, action, emotion, and continuity.
- Include `audienceDelivery`: important prompt information delivered through voiceover or character dialogue, with visible action or reaction backup.
- Keep dialogue as naturally performed action.
- Always include no subtitles, no watermark, no logo, no readable text.
- Do not ask the final video to render the 3x3 storyboard grid.

### 5. Storyboard Planning

For each shot, create a 3x3 storyboard prompt using the `seereel-storyboard-imagegen` structure. Store it in the shot prompt, shot script notes, or a shot-scoped reference asset so the canvas remains auditable.

If actual storyboard images are required for review, create/import them as assets or sketches, then stop. Publish to TOS only when the next step is approved Seedance generation.

## Handoff Checklist

Before ending, report:

- session title, session id, and `handoffUrl` or browser URL
- StoryPlan status and whether it is locked for review
- character assets created/reused
- scene assets created/reused
- shot count, duration per shot, and each shot's referenced `assetIds`
- storyboard prompt count and any pending reference-image work
- explicit statement that no video generation was run
- what the human should review before approving render

End with a clear approval gate: wait for human approval before any video render, stitch, or provider polling.
