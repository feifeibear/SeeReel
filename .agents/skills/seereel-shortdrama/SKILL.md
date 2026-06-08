---
name: seereel-shortdrama
description: Use when a user asks SeeReel to plan, direct, continue, repair, generate, stitch, or complete an AI short-drama/video workflow across multiple production stages.
---

# SeeReel Short Drama Orchestrator

## Boundary

Boundary: orchestrates stages. This skill owns routing, gates, stage order, render/stitch permission, and recovery direction. It does not rewrite the detailed deliverables owned by stage skills.

When a user asks for an end-to-end SeeReel film, route the work through:

```text
initial idea
  -> seereel-script-chat
  -> seereel-casting-assets
  -> seereel-cinematography
  -> seereel-canvas-review
  -> approved video generation
  -> stitch/final handoff
```

Use `seereel-cli` or `seereel-agent-session` only as transport/control surfaces. They create, patch, inspect, render, poll, publish, and stitch visible SeeReel state; they do not decide the creative content.

## Stage Ownership

| Stage | Owning skill | Output |
| --- | --- | --- |
| Script development | `seereel-script-chat` | Locked `StoryPlan`: premise, synopsis, characters, beats, dialogue language, audienceDelivery, research/review notes |
| Casting and production design | `seereel-casting-assets` | Approved character assets, scene assets, prop/style anchors, `assetIds`, style bible, coverage table |
| Cinematography | `seereel-cinematography` | Storyboard plan, shot nodes, `rawPrompt`/`prompt`, camera grammar, continuity wiring |
| Final consistency review | `seereel-canvas-review` | PASS/FAIL report and fallback target for each issue |
| Operation | `seereel-cli` / `seereel-agent-session` | API/CLI actions against visible canvas state |

## Operating Rules

- Keep all intermediate results visible in SeeReel state: session, script, beats, assets, storyboards, shots, prompts, renders, stitch jobs, and final video.
- Treat manual web edits as source of truth. Refresh current state before continuing after a human edit.
- Prefer full 15-second Seedance shots. Pack multiple related beats inside a shot when character, location, emotional continuity, and camera space are shared.
- Only enter paid video generation after canvas-review passes and the human explicitly approves continuing.
- Seedance workers need public or signed `http(s)` references. Publish local storyboard/reference media to TOS before using them as Seedance references.
- Generate adjacent narrative shots serially when they share characters, location, time, lighting, color grade, screen direction, or camera motion. Use previous-tail clips, tailframes, or first-frame anchors when continuity needs them.
- Do not use previous-tail clips or cross-shot video references across different locations, time jumps, or unrelated scene functions. Cross-scene video continuity can smear locations, costumes, props, and blocking; use explicit character `assetIds` instead.
- Wire `assetIds` by clear on-screen role. A shot should reference every recurring character who is clearly visible, speaking, or story-critical in that shot, but should not reference offscreen or intentionally blurred characters merely because they exist elsewhere in the film.
- Treat maps, flags, placards, signboards, scrolls, bamboo slips, papers, seals, UI-like panels, and any flat writable prop as high-risk when the user forbids subtitles or screen text. Replace them with physical blocking, firelight, footsteps, silhouettes, empty stone/wood surfaces, or spoken dialogue.
- When a two-character power scene repeatedly swaps identity or position, split the shot into explicit single-character beats before returning to a two-shot: character A alone, character B alone, action insert, then a simple wide reaction.
- Keep one spoken dialogue language across the whole session. Use natural diegetic sound by default; no per-shot music/BGM/score unless explicitly requested as a session-level music plan.
- Treat foreground-speech clarity as blocking. Dialogue shots need an explicit allowed speaker list; characters outside that list, bystanders, vendors, crowds, witnesses, and narrators must not produce intelligible foreground speech during that shot.
- If a real Seedance task is slow, keep polling until terminal success/failure unless the user asks for recovery. If VLM self-review repeatedly rejects the same render for a structural prompt issue, delete or retire that pending render through the API, simplify the prompt, and regenerate only the affected shot.

## Fallback Routing

When a review or render reveals a problem, do not patch randomly. Send it to the owning skill:

- Premise drift, weak structure, wrong POV, missing audience-facing information, or dialogue-language conflict -> `seereel-script-chat`.
- Character identity drift, mismatched visual style, missing recurring character reference, stale/off-session `assetIds`, scene/prop reference errors -> `seereel-casting-assets`.
- Weak camera grammar, unfilmable storyboard, missing shot objective, bad `rawPrompt`/`prompt`, broken screen direction, wrong continuity mode, storyboard-grid leakage -> `seereel-cinematography`.
- Unclear diagnosis across canvas nodes, prompts, edges, initial idea, and locked StoryPlan -> `seereel-canvas-review`.
- API/session ownership, handoff URL, TOS publish, render polling, stitch, or graph patch mechanics -> `seereel-cli` or `seereel-agent-session`.

## Final Output

After a successful run, report:

- session title and id
- browser URL or `handoffUrl`
- final local/download URL if video was generated
- shot readiness and stitch status
- any fallback loops that were triggered and the skill that owned the fix
