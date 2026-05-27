---
name: reelyai-storyboard-imagegen
description: Generate cinematic storyboard contact sheets for one Seedance shot using Codex imagegen or gpt-image-2. Use when the user asks for Codex imagegen storyboards, gpt-image-2 storyboard prompts, cinematic 3x3 storyboard sheets, Seedance shot visual summaries, 分镜故事板, 故事板参考图, or storyboard-to-Seedance reference workflows.
---

# ReelyAI Storyboard Imagegen

## Purpose

Create a cinematic storyboard that summarizes the visual arc of one Seedance-generated shot. The goal is not a random beautiful image; it is a coherent mini-sequence that helps a human and Seedance understand movement, continuity, tone, and shot language.

Use this skill before importing a storyboard into ReelyAI or before asking a model such as `gpt-image-2` / Codex imagegen to draw the storyboard.

## Required input

Before generating, make sure you have enough scene context:

- shot title and index
- script/action beat
- characters and wardrobe
- location and production design
- emotional tone and pacing
- target video ratio and duration
- camera/lens/movement requirements
- continuity constraints from previous/next shots
- any required visual references or brand/safety constraints

If the user has not provided a scene or shot description, ask for it first.

## Storyboard format

Generate one image as a cinematic contact sheet:

- Overall aspect ratio: `16:9`
- Layout: `3 x 3`, total `9` panels
- Panel order: left-to-right, top-to-bottom
- Each panel is a widescreen movie still from the same shot
- Each panel should include a small visible frame number `1` to `9` for human review
- The nine panels should show the beginning, progression, and end state of one Seedance video shot

Important: the 3x3 numbered contact sheet is for planning and review. If the image will be sent directly to Seedance as `reference_image`, prefer also generating or extracting a clean keyframe without panel borders, numbers, or labels. Seedance may otherwise imitate the contact-sheet layout.

## Film-director analysis

Before writing the image prompt, reason through:

- emotional arc
- movement progression
- character blocking
- screen direction
- environment continuity
- lighting continuity
- camera progression
- foreground/background layering
- the strongest frame to use as a later clean key reference

The sequence should feel like nine connected frames from a real edited film scene.

## Cinematic requirements

Include:

- strong composition and motivated framing
- realistic depth, perspective, and scale
- foreground, midground, and background layering
- motivated movie lighting with clear source direction
- consistent color grading across all panels
- varied but coherent camera language: establishing, wide, medium, close-up, over-the-shoulder, tracking, low-angle, high-angle, insert, or reaction shots as appropriate
- consistent characters, wardrobe, props, environment, weather, and lighting
- visible motion progression, not nine unrelated poses

Avoid:

- disconnected images
- inconsistent character designs
- inconsistent environments
- generic AI-looking beauty shots
- random dramatic lighting that breaks continuity
- excessive text, captions, logos, watermarks, or title cards outside the small frame numbers

## Prompt template

Use this structure for Codex imagegen / `gpt-image-2`:

```text
Create a professional cinematic storyboard contact sheet for one AI video shot.

Overall image: 16:9 aspect ratio, 3x3 grid, nine widescreen panels, panels numbered 1 through 9 for review.

Scene: [shot title, duration, and one-sentence premise]
Characters: [consistent character descriptions, wardrobe, props]
Location: [environment, time of day, production design, weather]
Tone: [emotional tone and pacing]
Continuity: [previous/next shot constraints, screen direction, lighting continuity]
Visual style: [cinematic genre, color grade, lens feel, texture]

Panel progression:
1. [opening state / establishing image]
2. [first movement or reaction]
3. [blocking change]
4. [tension or camera push]
5. [central dramatic beat]
6. [action/reaction continuation]
7. [closeup/insert/turning point]
8. [movement resolution]
9. [ending frame that leads into next shot]

Cinematic execution: strong composition, realistic movie lighting, motivated light sources, depth, foreground/background layering, consistent characters and environment, coherent camera language, production-ready film previsualization, no subtitles, no watermarks, no logo-like text, no random unrelated frames.
```

## ReelyAI handoff

After image generation:

1. Save or import the image into the target shot with `POST /api/shots/:shotId/sketches/import`.
2. If it is local `/media/...`, publish it before Seedance generation with `POST /api/sessions/:sessionId/storyboards/publish-tos` or the web button "故事板 TOS".
3. If Seedance fetches the storyboard slowly, compress it to a smaller JPEG before publishing.
4. For best video guidance, generate a clean keyframe from the approved storyboard and use that clean frame as the direct `reference_image` or first frame.

## Approval loop

After presenting a storyboard, ask whether the user wants changes. Accept adjustments such as:

- darker mood
- more dramatic light
- wider camera language
- more emotional close-ups
- stronger weather or atmosphere
- more handheld or more classical camera feeling
- slower or faster visual pacing
- more aggressive composition

When changes are requested, regenerate the entire storyboard while preserving continuity.

## Seedance prompt handoff

When the storyboard is approved, produce or refine the Seedance prompt with:

- cinematic atmosphere
- character and environment continuity
- emotional tone
- camera movement
- lighting direction
- action progression
- lens/composition behavior
- pacing and motion detail
- constraints against subtitles, watermarks, and unwanted text
