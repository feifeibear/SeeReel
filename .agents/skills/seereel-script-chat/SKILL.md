---
name: seereel-script-chat
description: Use when the user wants to discuss, develop, research, rewrite, review, or lock a SeeReel short-drama script before asset creation, storyboard, or video generation.
---

# SeeReel Script Chat

## Boundary

Boundary: script development only. This skill turns an initial idea into a locked script plan. It owns story, research, structure, character functions, dialogue intent, audience-facing information, and script review.

Output contract: StoryPlan.

Does not create character/scene assets. Does not write final Seedance shot prompts. Does not decide final `assetIds`, storyboard grids, camera grammar, continuity modes, render order, TOS publish, video generation, or stitch.

## Inputs

- Initial idea, user-provided source material, or document summary
- Explicit constraints: tone, POV, protagonist, spoken language, target duration, required ending, must-use facts
- Existing canvas state if the user asks to revise a current session

Treat short steering as hard constraints: examples include `尖锐讽刺`, `第一人称`, a named protagonist, a target song, or a required ending.

## StoryPlan Requirements

Create or revise a visible `StoryPlan` with:

- `premise`: the exact promise of the short
- `synopsis`: beginning / middle / end / payoff
- `theme`: emotional or satirical engine
- `spokenLanguage`: one language for all dialogue and narration unless explicitly multilingual
- `styleIntent`: high-level genre and tone only; detailed visual style is owned by `seereel-casting-assets`
- `characters`: name, role, want/fear, status, arc, first-appearance identityDelivery
- `beats`: ordered beat ladder with purpose, plot, dialogue intent, audienceDelivery, duration target
- `orientationPacket`: who/where/when/world-rule/relationship/stakes for the opening and major jumps
- `researchPacket`: sources or summarized references and how they affect character, plot, historical background, or anachronism rules
- `reviewNotes`: at least two review passes for a new idea, issues found, fixes applied, final lock status
- `locked: true` only when the script is ready for asset and shot work

Use `PATCH /api/sessions/:sessionId/script` or the equivalent CLI/API operation to save the StoryPlan. Keep research/review notes visible; do not leave them only in private scratch.

## Research Pass

Research before the first complete draft when the premise involves history, real jobs, technology, institutions, public figures, locations, cultural context, or a source document.

Collect enough to shape:

- character behavior and speech rhythm
- plot mechanisms, scams, rituals, rules, incentives, or institutional pressures
- historical background, material culture, props, clothing, architecture, law, transport, prices, and anachronism risks
- scene texture that affects later asset/cinematography work

For purely fictional ideas, research genre mechanics and comparable story structures rather than pretending no research is needed.

## Script Review Loop

After the first draft, run skeptical review passes before locking. Check:

- The opening makes the premise legible to a cold viewer.
- The protagonist, pressure, escalation, reversal, and payoff are clear.
- Each beat changes story state and causes the next beat.
- Story-critical facts are audience-facing through character dialogue, voiceover, overheard line, argument, question-answer, or visible action with spoken backup.
- Prompt-only lore, subtitles, readable signs, UI text, captions, and private notes do not carry essential plot facts.
- Dialogue and narration do not overlap as simultaneous foreground speech.
- Dialogue beats name their allowed speakers. Witnesses, crowds, vendors, bystanders, or narrators must not add intelligible third-party voices during a two-person exchange unless the story explicitly makes them speakers.
- Spoken lines stay in one language.
- Duration is plausible, with 15-second beat packing where possible.

Run at least two review passes for a new script idea. Revise until the reviewer is satisfied or a bounded loop exposes unresolved blockers. If the script still fails, stop and report the blocker instead of passing bad structure downstream.

## Handoff To Next Skill

Pass to `seereel-casting-assets` only after the StoryPlan is locked.

Handoff summary:

- title, premise, tone, spoken language
- locked StoryPlan id/session id
- characters that need visible assets
- recurring scenes/props/style anchors implied by the script
- beats and any audienceDelivery lines that assets must support
- unresolved constraints or deliberate no-asset exceptions
