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
- Create character assets early for every on-screen speaking or featured character whenever possible. A prompt-only session asset is draft-only; any recurring, cross-shot, named, or dialogue-carrying character must have a generated or imported image asset before video generation.
- Build visual continuity in two layers:
  - character assets preserve face, wardrobe, and identity across shots
  - storyboard references preserve shot composition, action progression, and mood
- Generate image assets with cinematic realism by default. Character assets should feel like
  live-action film costume tests or production stills, not flat illustration, cartoon concept art,
  toy-like renders, or generic AI portrait sheets.
- Avoid asking Seedance to render subtitles or readable dialogue text. Dialogue belongs in the script/beat intent unless the user explicitly wants visible text.
- Use one spoken dialogue language for the entire session. Infer it from the user's request or `Session.language`, record it in the story/style notes, and keep every quoted spoken line in that language across beats, shot scripts, and Seedance prompts. If the surrounding technical prompt is English, quoted dialogue still stays in the chosen spoken language. Do not mix Chinese and English dialogue unless the user explicitly asks for multilingual characters.
- Do not add per-shot music, BGM, soundtrack, stingers, or score cues by default. Generated music changes from shot to shot and stitches poorly. Ask for normal diegetic sound instead: spoken dialogue, room tone, footsteps, props, machinery, street ambience, crowd murmur, wind, breathing, and other in-world sound. Use music only when explicitly requested, and then define one continuous session-level music bed rather than different music per shot.
- Treat user edits in the Web UI as source of truth. Do not overwrite manual edits unless the user asks for regeneration.
- Keep every recurring character, scene, prop, storyboard, and shot prompt inside one session style family. A single mismatched cartoon/3D/illustration asset can pull later video generations away from the film's intended look.

## Required Context

Before saving final story state, establish:

- session title or working title
- core hook / premise
- tone and visual style
- target duration and shot count
- main characters that must remain consistent across shots
- plot arc, key beats, and dialogue intent
- single spoken dialogue language for all characters
- diegetic sound plan, with no music score by default
- any must-have locations, props, references, or constraints

If the user does not specify shot count, default to `ceil(targetDurationSec / 10)`, clamped to 3-8 shots.

## Session Style Consistency Contract

Before casting or image generation, write a **session style bible** and reuse it verbatim in every recurring character, scene, prop, storyboard, and shot prompt. The bible should name:

- medium: live-action film, documentary, stylized animation, game CG, etc.
- camera/lens/grade: camera feel, lens, grain, color contrast, saturation, lighting style
- period/material rules: era, fabric, skin texture, architecture, props, and what would be an anachronism
- negative style constraints: what must not appear, such as cartoon, anime, 3D render, toy proportions, plastic skin, flat concept art, glossy ad look, or character-sheet look

Use one visual family per session unless the user explicitly asks for a style contrast. Do not mix "photoreal live-action", "cartoon", "3D render", "anime", "storybook", and "character turnaround" language across assets in the same session.

### Asset Style Lock

For each recurring asset, save a style lock in its `description`, `prompt`, and tags:

```json
{
  "description": "【风格锁】与本片 Style Bible 一致：真实真人电影质感、1880 纽约、低饱和胶片、真实皮肤和布料；禁止卡通/3D/插画。",
  "prompt": "角色/场景描述 + Same visual family as the session style bible + strict negative style list.",
  "tags": ["style-lock", "photoreal-live-action", "session-reference"]
}
```

For character assets in a live-action session, prefer a production still or costume-test prompt that looks like a real actor in the film world. Avoid generic "turnaround", "three-view character sheet", "grey studio lineup", or "concept art" wording unless that exact reference format is needed; those phrases often make the asset look like a cartoon/3D model sheet and can poison later shots.

### Consistency Gate

Before any shot render:

- Generate or import the recurring character and scene references first.
- Run VLM review on generated assets when available.
- Treat style mismatch as blocking even when the review says `ok=true` or the numeric score is high. If review reasons mention cartoon, anime, 3D render, illustration, stylized face, plastic skin, toy proportions, wrong era, or mismatched realism, repair/regenerate before linking that asset to shots.
- Confirm every shot `assetIds` list uses only approved same-style assets. If an asset is repaired, patch every dependent shot prompt with a short style guard naming the updated asset.
- If the user manually edits an asset in the Web UI, refresh state and re-run this gate before generation.

## Micro-Script Contract

Before creating or patching shots, make the story answerable in one paragraph:

- Who is the ordinary-person anchor or emotional point of view?
- What fear, desire, scam, misunderstanding, or social pressure drives the short?
- What does each scene change?
- What reversal or punchline completes the title promise?

For a 60s / 4-shot satire or comedy, prefer this beat ladder unless the user gives a stronger structure:

1. Setup: show the new world and the protagonist's fear.
2. Trap: someone monetizes that fear.
3. Escalation: the crowd buys into a worse version of the trap.
4. Reversal: common sense exposes the scam and lands the final joke.

Dialogue should be short, performable, visually motivated, and in one consistent spoken language across the whole session. Put 1-3 lines per shot in the beat `plot` and the shot `script`. A good line either creates status, exposes hypocrisy, sharpens fear, or lands the joke. Do not write exposition that only explains lore.

Sound design should be ordinary in-world audio, not per-shot music. Write prompt language such as "natural diegetic sound only: dialogue in Mandarin Chinese throughout, room tone, footsteps, prop handling, street ambience; no music score, no BGM" and adapt the dialogue-language phrase to the selected session language.

If the current draft feels like unrelated images, stop generation and repair the `StoryPlan` first. Patch the session story and all affected shot prompts before rendering or stitching.

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
- `style`: concise visual style and constraints, copied from the session style bible
- `targetDurationSec`: shotCount * 10 unless the user specifies another value

### 2. Casting

Extract every on-screen speaking or featured character from the script beats, not only the obvious protagonist. Door-to-door targets, customers, clerks, teachers, hecklers, rivals, and anyone who changes the scene should become a session-scoped character asset whenever possible.

Recurring and cross-shot characters have a stricter rule: if a character appears in two or more shots, is named, carries dialogue, or is visually important to the joke, they must have a generated or imported image asset before video generation. Do not render a recurring character from prompt text alone.

Extras, crowds, and one-off background roles may remain uncast only when they are not individually recurring and do not need stable identity. If a crowd has a recognizable function across shots, create a group/background character asset such as `电气课学员人群` or `投机商围观者`.

For each character asset, first create a session-scoped asset with:

```json
{
  "name": "角色名",
  "type": "character",
  "mediaKind": "none",
  "description": "【选角资产】【风格锁】角色身份、外观、服装、气质、跨分镜一致性要求；复用本片 session style bible。",
  "prompt": "Character reference prompt: face identity, age, wardrobe, posture, story function, exact session style bible, strict negative style constraints.",
  "tags": ["cast", "script-chat", "session-reference", "style-lock", "角色名"],
  "ownerSessionId": "session id"
}
```

Use:

```text
POST /api/assets
PATCH /api/assets/:assetId
```

Do not rely on `POST /api/sessions/:sessionId/cast` as the only casting path, because image generation may fail or be rate/billing limited. For recurring, cross-shot, named, speaking, or featured characters, call:

```text
POST /api/assets/:assetId/generate
```

If image generation fails for a recurring, cross-shot, named, speaking, or featured character, keep the placeholder asset only for draft review, mark the character as blocking, and stop before video render until the user approves an imported replacement or regeneration succeeds.

### Character Asset Coverage Gate

Before creating or patching shots, run a character coverage pass:

- For every shot, list the visible, speaking, and featured characters.
- Create a character asset for each visible speaking or featured character whenever possible.
- Any cross-shot or recurring character must have `mediaKind: "image"` or an imported visual asset before video generation; `mediaKind: "none"` is only allowed in draft planning.
- Every shot `assetIds` list must include the character assets for the characters visible in that shot.
- If you add a new character to a shot during script repair, create or generate that character asset immediately, then patch the affected shot `assetIds`.
- For extras and crowds, either keep them purely descriptive if they are one-off background texture, or create a group character asset if they recur or influence the plot.

When writing character image prompts, prefer:

- cinematic photorealism, live-action film costume test, realistic skin texture and fabric detail
- neutral studio or controlled movie lighting, sharp face, full-body readable costume
- exact session style bible copied into the prompt, including the same camera/lens/grade and negative style list
- if using "A 饰演 B", face and performer identity come from A; wardrobe, hair styling, role symbols,
  posture, and scene function come from B

Avoid:

- cartoon, anime, flat concept art, toy render, plastic skin, over-smoothed beauty portrait
- unclear face, tiny face, distorted turnaround, extra characters, text labels, logos, subtitles
- mixing reference formats in one session, such as one actor-like production still beside another character-sheet or 3D model reference

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

Dialogue rule: write what characters say or imply inside `plot` or `purpose`, keep every spoken line in the selected session language, and add prompt language such as "dialogue is performed naturally in [language] throughout; no subtitles, no readable on-screen text" when generating video prompts.

Audio rule: include normal diegetic sound in prompts, but no per-shot music, no BGM, no score, and no stingers unless the user explicitly asked for a continuous music bed.

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
- the session style bible or a compact style guard that matches the approved assets
- camera and lighting language
- continuity constraints from previous/next shot
- "no subtitles, no watermark, no logo, no readable text"

If a shot mentions a repaired asset, add a direct guard such as:

```text
Style guard for @角色名: use the newly approved photoreal live-action reference only; realistic skin, period costume, same film grade; no cartoon, no 3D render, no stylized animated face.
```

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
- created session character assets, including which ones are generated/imported versus draft-only placeholders
- character asset coverage: each shot's visible/speaking characters are linked in `assetIds`, and recurring characters have generated/imported visuals
- saved story status
- shot prompt readiness
- generated storyboard prompt count
- any storyboard images imported or pending
- next recommended action: review storyboards, generate video shots, or revise script

## Failure Handling

- Character image generation failure for a one-off draft character: keep the placeholder character asset and continue with a visible warning.
- Character image generation failure for a recurring, cross-shot, named, speaking, or featured character: keep the placeholder only as draft state, mark it blocking for video generation, and either regenerate or import a replacement before render.
- Missing user details: make a reasonable draft, mark assumptions, and ask one focused follow-up.
- Storyboard image generation unavailable: output the 3x3 prompts and leave image import pending.
- TOS publish unavailable: keep local sketches visible and warn that Seedance needs remote `http(s)` references.
- Seedance reference timeout later in production: compress the storyboard or use a clean keyframe reference derived from the storyboard.
