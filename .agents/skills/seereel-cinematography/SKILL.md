---
name: seereel-cinematography
description: Use when a locked SeeReel StoryPlan and approved assets need storyboard planning, shot nodes, camera language, continuity wiring, or Seedance-ready prompt contracts.
---

# SeeReel Cinematography

## Boundary

Boundary: storyboard, shot design, and prompts only. This skill owns storyboard planning, shot nodes, `rawPrompt`/`prompt`, camera grammar, blocking, continuity wiring, reference roles, and Seedance prompt contracts.

Input contract: locked StoryPlan and approved assetIds.

Output contract: storyboard plan, shot nodes, rawPrompt/prompt, and continuity wiring.

Does not rewrite the StoryPlan. Does not create or approve casting assets. Does not run final consistency review, paid video generation, polling, stitch, or final handoff.

## Inputs

- Locked StoryPlan from `seereel-script-chat`
- Approved character/scene/prop assets and `assetIds` from `seereel-casting-assets`
- Existing shot nodes or storyboard references, if repairing a session
- Initial idea for drift checking only, not script rewriting

If the script or assets are not locked, stop and return to the owning skill.

## Shot Planning

Prefer full 15-second Seedance shots. Pack related micro-beats inside one shot when they share character, location, lighting, and emotional continuity.

For each shot, create:

- title and duration
- scene objective
- story state entering and exiting the shot
- visible cast and required references
- `assetIds` limited to characters/scenes/props visible or functionally needed in this shot
- storyboard prompt or storyboard asset link
- `rawPrompt` and composed `prompt`
- continuity mode and cut bridge

Use `POST /api/sessions/:sessionId/storyboard` and `PATCH /api/shots/:shotId` or the equivalent CLI node operations.

## Camera Grammar

Every shot needs camera grammar, not generic cinematic adjectives:

- camera motivation: why the camera moves or stays still
- coverage ladder: WS/MS/CU, 远景/中景/近景/特写, insert, reaction, or lock-off plan
- axis and screen direction: 180-degree line, eyelines, left/right movement
- blocking before movement: actor positions, entrances, crosses, hands, props, reactions
- attention target: the face, object, handoff, receipt, door, crowd turn, or contradiction the viewer must notice
- cut bridge: match on action, eyeline match, reaction shot, insert/cutaway, sound bridge, previous-tail, tailframe, or deliberate hard cut

For comedy and satire, stage the visual punctuation: held reaction, deadpan wide, prop insert, crowd cutaway, or a final non-speaking face.

## Seedance Prompt Contract

Each `rawPrompt`/`prompt` should read like a production contract, not a synopsis:

```text
Shot identity:
Reference roles:
Opening frame:
Shot size/framing:
0-4s:
4-9s:
9-13s:
13-15s:
Dialogue/sound:
Camera/style:
Exit frame:
Negative constraints:
Continuity mode:
```

Rules:

- Important story facts from `audienceDelivery` must be spoken through character dialogue or voiceover, with visible action/reaction backup.
- Quoted dialogue stays in the session spoken language.
- Use natural diegetic sound only unless the StoryPlan explicitly requests session-level music.
- No subtitles, no watermark, no logo, no readable text overlays unless explicitly requested.
- Do not fill every reference slot by habit; assign each reference a function such as character anchor, scene tone, prop detail, camera/motion reference, or clean first frame.
- Dry-run or inspect the final composed prompt before paid render. Remove stale assets, old characters, storyboard-grid instructions, mixed-language dialogue, and contradictory reference modes.

## Storyboard Planning

Use `seereel-storyboard-imagegen` for storyboard contact-sheet image prompts.

Storyboard requirements:

- declared grid such as 2x2, 2x4, or 3x3
- every panel is a complete movie still
- every panel is a filmable action, reaction, object insert, camera move, blocking change, reveal, or exit handoff
- not a concept board, mood board, poster, or symbolic collage

If a contact sheet is used as a Seedance reference, explicitly tell Seedance it guides composition/action only and must not render panel borders, numbers, labels, captions, or grid layout. Prefer a clean keyframe for first-frame precision.

## Continuity Wiring

Choose one continuity mode per shot:

| Situation | Field/action |
| --- | --- |
| Shot starts from exact image | `firstFrameAssetId` |
| Shot begins exactly from previous final frame | extract tailframe, publish TOS, set `firstFrameAssetId` |
| Shot follows previous motion/framing/lighting | `usePreviousShotClip: true`, `previousShotClipSec: 2` |
| Shot uses previous shot as explicit reference | `referenceVideoFromShotId` or trimmed reference-video |
| Shot uses storyboard composition only | attach storyboard asset as a reference role |
| Hard cut/time jump/location jump | name it as a deliberate hard cut |

Do not stack mutually exclusive modes. Reference-video continuity should usually use a 2-4 second trimmed clip, not the whole previous 15-second shot.

## Repair Loop

When review finds shot/prompt problems:

- patch the earliest broken shot first
- change one variable per retry: prompt wording, reference set, continuity mode, trimmed duration, or generation parameter
- keep notes visible in the shot or session
- return script drift to `seereel-script-chat`
- return asset/style drift to `seereel-casting-assets`

## Handoff To Canvas Review

Pass to `seereel-canvas-review`:

- locked StoryPlan reference
- approved assets with exact `assetIds`
- shot list with `rawPrompt`/`prompt`
- storyboard plans/assets
- edge/reference wiring
- known intentional exceptions
