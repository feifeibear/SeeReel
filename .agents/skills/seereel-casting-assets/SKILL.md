---
name: seereel-casting-assets
description: Use when a SeeReel script or StoryPlan needs character, scene, prop, style, or reference assets prepared before storyboard, shot prompts, or video generation.
---

# SeeReel Casting And Assets

## Boundary

Boundary: character and scene assets only. This skill owns casting, production-design references, style consistency, asset generation/import, asset approval, and `assetIds` coverage.

Input contract: initial idea and locked StoryPlan.

Output contract: approved character assets, scene assets, and assetIds.

Does not change plot beats or dialogue. Does not write final shot prompts. Does not decide camera grammar, storyboard panel sequence, continuity mode, render order, or stitch.

## Inputs

- Initial idea for intent checking
- Locked `StoryPlan` from `seereel-script-chat`
- Any user-uploaded images, style references, cast references, location images, or existing session assets
- Target medium and constraints from the script, such as live-action realism, animation, period setting, wardrobe, prop rules, and forbidden styles

Refresh SeeReel state before editing. Manual web edits are source of truth.

## Asset Outputs

Create or approve visible session-scoped assets:

- main and recurring character assets
- speaking/featured one-shot character assets when they affect story clarity
- scene/location assets for recurring spaces or production-design anchors
- prop/style assets when a prop, invention, costume, interface, or symbol drives the plot
- optional clean keyframes or accepted rendered-frame anchors after video exists

Every output must be visible in the session and recorded with usable `assetIds`.

## Style Bible

Own the session style bible:

- medium: live-action film, documentary, animation, game CG, etc.
- camera/lens/grade: texture, lighting, saturation, contrast, grain, realism
- period/material rules: clothing, skin, architecture, props, interfaces, era constraints
- negative style constraints: cartoon, anime, 3D render, toy proportions, plastic skin, flat illustration, glossy ad look, wrong era, or other forbidden drift

Reuse the style bible in every recurring character, scene, prop, and storyboard reference request. A single incompatible reference can poison later Seedance output.

## Character Asset Coverage

Build a character asset coverage table:

| Role | Appears in beats | Required asset | Approved assetId | Continuity note |
| --- | --- | --- | --- | --- |

Rules:

- Recurring, named, speaking, featured, or emotionally important characters need an explicit continuity plan.
- Prefer generated or imported image assets for recurring protagonists before video generation.
- Extras/crowds may remain prompt-only only when they do not need stable identity.
- Do not attach the whole cast to every shot. Pass only the assets that are visible or explicitly needed in that shot to `seereel-cinematography`.
- If an accepted render establishes a stronger actor face, create a visible rendered-frame identity anchor and prefer it for later repairs.

## Scene And Prop Coverage

Build a scene/prop coverage table:

| Scene/prop | Beats | Purpose | Approved assetId | Drift risks |
| --- | --- | --- | --- | --- |

Scene assets should describe layout, light, entrances/exits, material details, and story-critical props. Props should explain what the object proves, sells, threatens, or reverses.

## Quality Gate

Fail and repair before handoff when:

- assets mix incompatible media, such as live-action photo, cartoon, 3D render, anime, illustration, studio portrait, and concept art without an intentional style contrast
- VLM review is numerically high but reasons mention cartoon, anime, 3D render, plastic skin, toy proportions, wrong era, wrong age, wrong clothing, or mismatched medium
- a recurring character has no approved visual plan
- an asset belongs to another session and has not been copied/imported into the current session
- a stale asset from an old story remains wired to a current shot
- a scene or prop asset contradicts the locked StoryPlan

When repairing, remove stale `assetIds` and stale `@AssetName` mentions from dependent shots or return the issue to `seereel-cinematography` for prompt rewiring.

## API Surface

Use SeeReel visible-state APIs or CLI equivalents:

```text
GET /api/state
POST /api/assets
PATCH /api/assets/:assetId
POST /api/assets/:assetId/generate
POST /api/sessions/:sessionId/storyboards/publish-tos
```

Do not use private files as the final source of truth. Imported or recovered references must be written back into the session.

## Handoff To Cinematography

Pass to `seereel-cinematography`:

- locked StoryPlan reference
- style bible
- approved character/scene/prop asset list with exact `assetIds`
- per-beat required references and deliberate prompt-only/no-reference exceptions
- rejected assets and why they must not be reused
