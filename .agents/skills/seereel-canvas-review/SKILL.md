---
name: seereel-canvas-review
description: Use when a SeeReel canvas needs final consistency review before video generation, especially checking initial idea, locked StoryPlan, assets, shot prompts, node links, and fallback ownership.
---

# SeeReel Canvas Review

## Boundary

Boundary: final consistency review and fallback routing only. This skill is the quality gate after script, assets, and cinematography have produced visible canvas state.

It checks the initial idea, locked StoryPlan, node prompts, edges, assetIds, storyboard references, and continuity wiring. It may complete still-image/storyboard/reference generation needed for review, but it does not generate video.

Does not invent replacement content itself. When something fails, route the fix to the owning skill.

## Inputs

- Initial idea or source material summary
- Locked StoryPlan from `seereel-script-chat`
- Approved character/scene/prop assets from `seereel-casting-assets`
- Shot nodes, storyboard plans, `rawPrompt`/`prompt`, edges, and continuity wiring from `seereel-cinematography`
- Current SeeReel state from API/CLI, refreshed after any manual UI edit

## Review Checklist

Inspect the visible canvas, not private notes:

1. Initial idea alignment: tone, POV, protagonist, premise, required facts, and ending still match the user's request.
2. StoryPlan alignment: every shot exists to serve a locked beat; no shot introduces a new plot, old premise, wrong character, or missing payoff.
3. Character consistency: recurring visible/speaking/featured roles have approved `assetIds` or intentional exceptions.
4. Scene/prop consistency: assets match the StoryPlan, style bible, period/material rules, and intended scene function.
5. Prompt consistency: every `rawPrompt`/`prompt` matches its beat, audienceDelivery, dialogue language, sound rules, camera grammar, and negative constraints.
6. Edge/reference consistency: node links, `assetIds`, first-frame assets, previous-tail clips, `referenceVideoFromShotId`, storyboard references, and TOS-published URLs agree with the visible graph.
7. Storyboard quality: declared grid, complete movie-still panels, filmable action/reaction/object/camera progression, no concept-board output.
8. Continuity: adjacent shots bridge through action, eyeline, reaction, insert/cutaway, sound, previous-tail, tailframe, or a named hard cut.
9. Audience comprehension: story-critical prompt facts are delivered through dialogue/voiceover and visible action/reaction, not only hidden in prompt lore or subtitles.
10. Render readiness: local `/media/...` references that will be used by Seedance are published to TOS; video generation is still blocked until approval.

## Verdict Format

Write a visible handoff report:

```text
Canvas Review: PASS | FAIL
Initial idea match:
StoryPlan match:
Assets:
Shot prompts:
Edges/references:
Storyboard images:
Continuity:
Fallbacks required:
Approval gate:
```

Do not generate video. End with an explicit approval gate.

## Fallback Routing

Use precise ownership:

- If the premise, plot, POV, beat ladder, dialogue, audienceDelivery, or StoryPlan lock is wrong, fallback to `seereel-script-chat`.
- If character identity, scene style, prop design, visual family, off-session asset ownership, stale `assetIds`, or missing reference coverage is wrong, fallback to `seereel-casting-assets`.
- If storyboard sequence, shot node design, camera grammar, `rawPrompt`/`prompt`, continuity mode, edge wiring, first-frame/tailframe/previous-tail use, or Seedance prompt contract is wrong, fallback to `seereel-cinematography`.
- If REST/CLI state, session ownership, handoff, TOS publish, polling, or patch mechanics are wrong, fallback to `seereel-cli` or `seereel-agent-session`.

Record every fallback as:

```text
Issue:
Evidence:
Owning skill:
Required repair:
Re-review scope:
```

After the owning skill repairs the issue, re-run only the affected review scope, then the final whole-canvas PASS check.

## Still Image Completion

If review needs reference images to judge consistency, this skill may trigger or request still-image completion for characters, scenes, props, or storyboard references through the proper asset/storyboard APIs. Keep those images visible in the canvas and write their `assetIds` or sketch references back to the relevant nodes.

This permission does not include video generation, Seedance polling, stitch, or final download.

## Handoff

A PASS handoff must include:

- session title and id
- browser URL or `handoffUrl`
- locked StoryPlan status
- approved asset list and key `assetIds`
- shot count and prompt readiness
- storyboard/reference readiness
- TOS publish status for references needed by Seedance
- explicit statement: no video generation was run in review
- next step: human approval, then `seereel-shortdrama` may enter generation
