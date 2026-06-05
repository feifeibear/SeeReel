---
name: seereel-script-chat
description: Chat with the user to shape a ReelyAI short-drama script, cast session-scoped characters, decide dialogue and shot count, generate Seedance prompts, and prepare 3x3 storyboard prompts/references. Use when the user wants to 聊剧本, 理清创意, 选角, 剧情, 台词, 分镜数, storyboard, or a guided script-development flow before video generation.
---

# ReelyAI Script Chat

## Purpose

Act as a script co-director for ReelyAI. Guide the user through a lightweight conversation that turns an idea into a concrete ReelyAI session with:

- session-scoped character assets for continuity
- a saved `StoryPlan`
- shot prompts derived from story beats
- 3x3 storyboard prompts for each shot
- optional imported storyboard images when image generation is available

This skill is an Agent workflow only. Do not add or require a Web chat panel.

## Operating Principles

- Keep the conversation focused. Ask a few high-leverage questions, then fold each answer into the working story draft.
- Prefer visible app state over private scratch notes. Save sessions, assets, story plans, shots, and sketches through the local API.
- Create character assets early, but do not block on image generation. A prompt-only session asset is valid and useful.
- Build visual continuity in two layers:
  - character assets preserve face, wardrobe, and identity across shots
  - storyboard references preserve shot composition, action progression, and mood
- Generate image assets with cinematic realism by default. Character assets should feel like
  live-action film costume tests or production stills, not flat illustration, cartoon concept art,
  toy-like renders, or generic AI portrait sheets.
- Avoid asking Seedance to render subtitles or readable dialogue text. Dialogue belongs in the script/beat intent unless the user explicitly wants visible text.
- Treat user edits in the Web UI as source of truth. Do not overwrite manual edits unless the user asks for regeneration.

## Required Context

Before saving final story state, establish:

- session title or working title
- core hook / premise
- tone and visual style
- target duration and shot count
- main characters that must remain consistent across shots
- plot arc, key beats, and dialogue intent
- any must-have locations, props, references, or constraints

If the user does not specify shot count, default to `ceil(targetDurationSec / 10)`, clamped to 3-8 shots.

## Workflow

### 1. Project Setup

Select or create one session for the short drama.

Use:

```text
GET /api/state
POST /api/sessions
PATCH /api/sessions/:sessionId
```

Recommended defaults for a new session:

- `title`: user title or concise working title
- `logline`: one-sentence hook
- `style`: concise visual style and constraints
- `targetDurationSec`: shotCount * 10 unless the user specifies another value

### 2. Casting

Extract only characters that need cross-shot consistency. Do not create assets for extras, crowds, or one-off background roles.

For each continuity character, create a session-scoped placeholder asset with:

```json
{
  "name": "角色名",
  "type": "character",
  "mediaKind": "none",
  "description": "【选角资产】角色身份、外观、服装、气质、跨分镜一致性要求。",
  "prompt": "Character reference prompt: face identity, age, wardrobe, posture, story function, style constraints.",
  "tags": ["cast", "script-chat", "session-reference", "角色名"],
  "ownerSessionId": "session id"
}
```

Use:

```text
POST /api/assets
PATCH /api/assets/:assetId
```

Do not rely on `POST /api/sessions/:sessionId/cast` as the only casting path, because image generation may fail or be rate/billing limited. If image generation is available, optionally call:

```text
POST /api/assets/:assetId/generate
```

If image generation fails, keep the placeholder asset and continue.

When writing character image prompts, prefer:

- cinematic photorealism, live-action film costume test, realistic skin texture and fabric detail
- neutral studio or controlled movie lighting, sharp face, full-body readable costume
- if using "A 饰演 B", face and performer identity come from A; wardrobe, hair styling, role symbols,
  posture, and scene function come from B

Avoid:

- cartoon, anime, flat concept art, toy render, plastic skin, over-smoothed beauty portrait
- unclear face, tiny face, distorted turnaround, extra characters, text labels, logos, subtitles

### 3. Story And Dialogue

Convert the conversation into a `StoryPlan`:

```json
{
  "premise": "一句话前提",
  "synopsis": "完整短片梗概",
  "theme": "主题或喜剧/情绪机制",
  "tone": "影像风格、节奏、禁忌项",
  "characters": [
    {
      "name": "角色名",
      "role": "身份和戏剧功能",
      "arc": "开场状态 -> 变化 -> 结尾状态",
      "assetId": "session asset id",
      "assetMention": "@角色名"
    }
  ],
  "beats": [
    {
      "index": 1,
      "title": "分镜标题",
      "purpose": "本分镜叙事目的",
      "plot": "画面中发生的动作；可包含台词意图但不要要求可读字幕",
      "emotion": "情绪变化",
      "visual": "场景、构图、镜头、光线、动作调度",
      "assetMentions": ["@角色名"],
      "durationSec": 10
    }
  ],
  "locked": true,
  "model": "script-chat"
}
```

Use:

```text
PATCH /api/sessions/:sessionId/script
```

Dialogue rule: write what characters say or imply inside `plot` or `purpose`, but add prompt language such as "dialogue is performed naturally; no subtitles, no readable on-screen text" when generating video prompts.

### 4. Shot Prompts

Generate shot prompts from the saved story.

Use:

```text
POST /api/sessions/:sessionId/storyboard
```

Then inspect/patch shots as needed:

```text
PATCH /api/shots/:shotId
```

Each shot prompt should include:

- short film title
- shot index and title
- exact action beat
- character mentions such as `@角色名`
- camera and lighting language
- continuity constraints from previous/next shot
- "no subtitles, no watermark, no logo, no readable text"

### 5. 3x3 Storyboard Prompts

For each shot, produce a 3x3 storyboard image prompt using the `seereel-storyboard-imagegen` skill format.

The output should be one prompt per shot:

```text
Create a professional cinematic storyboard contact sheet for one AI video shot.

Overall image: 16:9 aspect ratio, 3x3 grid, nine widescreen panels, panels numbered 1 through 9 for review.

Scene: Shot [index]/[count], [title], [duration] seconds. [one-sentence premise]
Characters: [consistent character descriptions, wardrobe, props, @asset mentions]
Location: [environment, time, production design]
Tone: [emotion and pacing]
Continuity: [previous/next shot constraints]
Visual style: [genre, grade, lens feel]

Panel progression:
1. ...
2. ...
3. ...
4. ...
5. ...
6. ...
7. ...
8. ...
9. ...

Cinematic execution: strong composition, realistic movie lighting, motivated light sources, depth, foreground/background layering, consistent characters and environment, coherent camera language, production-ready film previsualization, no subtitles, no watermarks, no logo-like text, no random unrelated frames.
```

If an image is actually generated, import it as a shot-scoped sketch:

```text
POST /api/shots/:shotId/sketches/import
```

Then publish before Seedance generation when needed:

```text
POST /api/sessions/:sessionId/storyboards/publish-tos
```

Important: the 3x3 sheet is a planning and reference artifact. When handing off to Seedance, state that the storyboard defines composition/action progression, while character assets define face/wardrobe identity. Do not ask Seedance to render the 3x3 grid as the final video.

## Handoff Checklist

Before ending the script-chat workflow, report:

- session title and id
- selected shot count and target duration
- created session character assets
- saved story status
- shot prompt readiness
- generated storyboard prompt count
- any storyboard images imported or pending
- next recommended action: review storyboards, generate video shots, or revise script

## Failure Handling

- Character image generation failure: keep the placeholder character asset and continue.
- Missing user details: make a reasonable draft, mark assumptions, and ask one focused follow-up.
- Storyboard image generation unavailable: output the 3x3 prompts and leave image import pending.
- TOS publish unavailable: keep local sketches visible and warn that Seedance needs remote `http(s)` references.
- Seedance reference timeout later in production: compress the storyboard or use a clean keyframe reference derived from the storyboard.
