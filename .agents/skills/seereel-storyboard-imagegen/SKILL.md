---
name: seereel-storyboard-imagegen
description: Use when a SeeReel shot needs a storyboard contact-sheet image prompt, Codex imagegen/gpt-image-2 storyboard reference, or clean keyframe planning before Seedance.
---

# SeeReel Storyboard Imagegen

## Boundary

Boundary: storyboard reference images only. This skill owns cinematic contact-sheet prompts and clean keyframe planning for one shot.

Does not author the full Seedance video prompt. Does not decide script, casting, `assetIds`, camera grammar for the whole film, continuity mode, render order, or stitch.

Use `seereel-cinematography` for the full shot contract and `seereel-casting-assets` for approved character/scene references.

## Inputs

- shot index/title and duration
- locked beat purpose from StoryPlan
- approved character/scene/prop references
- location, wardrobe, action progression, emotional turn
- camera intent from `seereel-cinematography`
- previous/next continuity constraint
- target aspect ratio

If the shot contract is missing, return to `seereel-cinematography` before drawing.

## Contact Sheet Rules

Default to a 16:9 image containing a strict declared grid: 2x2, 2x4, 3x3, or another justified grid.

- Panel order: left-to-right, top-to-bottom.
- Every panel is a complete movie still.
- Every panel shows one visible, filmable action, reaction, object insert, camera move, blocking change, reveal, or exit handoff.
- The sequence shows opening state, progression, central turn, consequence, and ending/handoff frame.
- Keep character, wardrobe, location, lighting, screen direction, and object continuity stable across panels.
- It is not a concept board, mood board, poster, symbolic collage, or abstract theme sheet.
- Small frame numbers are allowed for human review.

If the contact sheet will be passed to Seedance as a reference image, also create or identify a clean keyframe without grid borders, numbers, labels, or captions whenever first-frame precision matters.

## Prompt Template

```text
Create a professional cinematic storyboard contact sheet for one SeeReel AI video shot.

Overall image: 16:9 aspect ratio, strict [declared grid], complete widescreen panels, ordered left-to-right/top-to-bottom.
Scene: [shot title, duration, and one-sentence premise]
Characters: [approved character references, wardrobe, props]
Location: [environment, time, production design]
Tone: [emotional tone and pacing]
Continuity: [previous/next handoff, screen direction, lighting continuity]
Visual style: [style bible summary]

Panel progression:
1. [opening frame and story state]
2. [filmable action or reaction]
3. [blocking or object action]
4. [pressure or camera/actor movement]
5. [central reveal, decision, contradiction, or joke]
6. [reaction or consequence]
7. [insert/closeup/turning point tied to a concrete object/face/hand]
8. [movement resolution or handoff setup]
9. [ending frame leading to next shot]

Cinematic execution: strong composition, realistic depth, motivated movie lighting, foreground/midground/background layering, consistent characters and environment, coherent camera language, production-ready previsualization, strict grid, no concept-board symbolism, no subtitles, no watermarks, no logo-like text, no random unrelated frames.
```

Adjust panel count to match the declared grid exactly.

## Quality Gate

Reject or regenerate when:

- the grid count is wrong
- cells are cropped, missing, merged, or poster-like
- panels are abstract nouns or mood labels
- characters/wardrobe/location drift between panels
- first/middle/final states do not describe a usable shot arc
- the sheet contains subtitles, caption blocks, title cards, logo text, or fake UI
- the final panel does not provide an exit/handoff frame when continuity needs one

## Handoff

Return to `seereel-cinematography`:

- declared grid
- final storyboard prompt
- generated/imported storyboard asset id or sketch id if available
- recommended clean keyframe, if needed
- notes about what Seedance must not copy from the contact sheet: panel borders, numbers, labels, captions, or grid layout
