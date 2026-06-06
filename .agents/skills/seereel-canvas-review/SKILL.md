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

## Composition With Other Skills

- Use `seereel-script-chat` for story spine, character functions, dialogue packets, beat ladder, and StoryPlan shape.
- Use `seereel-storyboard-imagegen` for per-shot 3x3 storyboard prompt language.
- Use `seereel-agent-session` or `seereel-cli` for creating and patching the visible session, assets, and shots.

## Intake

Start with the user's idea. Ask at most two missing questions only when the answer materially changes the canvas:

- target duration or shot count
- tone/style or reference film
- must-have characters, locations, props, or ending

If the user does not answer, choose conservative defaults:

- language: Chinese unless the user writes in English
- duration: 60s
- shot count: `Math.ceil(targetDurationSec / 15)`, clamped to 3-8 for ordinary short dramas
- style: grounded cinematic realism, no subtitles, no watermark, no readable text overlays

## Canvas Readiness Contract

Before handoff, the canvas must contain:

1. A session with title, logline, style, target duration, and shot count.
2. A saved `StoryPlan` with premise, synopsis, theme, tone, characters, beats, dialogue intent, and locked review status.
3. Character assets for every recurring role. Use prompt-only placeholders when image generation is not needed yet.
4. Scene assets for recurring locations or production-design anchors. Tag them as `scene assets`.
5. Shot nodes for every beat, each with title, duration, script/action, `rawPrompt`, `prompt`, and status no later than `scripted` or `draft`.
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

Convert the idea into a concrete script layer:

```json
{
  "premise": "一句话前提",
  "synopsis": "完整短片梗概",
  "theme": "主题或喜剧机制",
  "tone": "影像风格、节奏、禁忌项",
  "characters": [
    {
      "name": "角色名",
      "role": "身份和戏剧功能",
      "arc": "开场状态 -> 变化 -> 结尾状态",
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
      "emotion": "情绪变化",
      "visual": "场景、构图、镜头、光线、动作调度",
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
  "script": "动作、调度、自然表演的台词意图。",
  "rawPrompt": "短片名；分镜编号；动作；@角色名；@场景名；摄影、光线、连续性；no subtitles, no watermark, no logo, no readable text。",
  "prompt": "扩写后的 Seedance prompt，但仍然只保存不提交。",
  "assetIds": ["asset_character", "asset_scene"]
}
```

Prompt requirements:

- State which characters and scenes are referenced.
- Include camera, light, blocking, action, emotion, and continuity.
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
