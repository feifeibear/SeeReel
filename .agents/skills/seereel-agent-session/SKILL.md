---
name: seereel-agent-session
description: Use when an agent needs direct SeeReel REST API control for sessions, assets, storyboards, shots, renders, polling, TOS publish, stitching, or visible canvas state repair.
---

# SeeReel Agent Session

## Boundary

Boundary: REST session control only. This skill owns API mechanics for visible SeeReel state.

It does not decide story, casting, production design, camera language, storyboard sequence, prompt quality, or final creative approval. Use the stage skills for those decisions, then use this skill to create, patch, inspect, poll, publish, and stitch their outputs.

## Base URL

Default:

```text
process.env.SEEREEL_AGENT_BASE_URL ||
process.env.CINEMA_AGENT_BASE_URL ||
"http://localhost:5173"
```

Check health with:

```text
GET /api/state
```

If the service is unavailable, start the app with `npm run dev` or point `SEEREEL_AGENT_BASE_URL` at the running service.

## API Responsibilities

Use REST APIs for:

- session create/select/update
- StoryPlan persistence
- asset create/import/generate/update
- storyboard and sketch import
- shot create/patch/generate/poll
- tailframe extraction and canvas-node writeback
- storyboard publish to TOS
- render status inspection
- stitch and stitch polling
- final download URL lookup

Keep every operation auditable in web state.

## Common Operations

```text
GET /api/state
POST /api/sessions
PATCH /api/sessions/:sessionId
PATCH /api/sessions/:sessionId/script
POST /api/assets
PATCH /api/assets/:assetId
POST /api/assets/:assetId/generate
POST /api/sessions/:sessionId/storyboard
PATCH /api/shots/:shotId
POST /api/shots/:shotId/generate
POST /api/shots/:shotId/poll
POST /api/shots/:shotId/tailframe
POST /api/sessions/:sessionId/storyboards/publish-tos
POST /api/sessions/:sessionId/stitch
POST /api/sessions/:sessionId/stitch/poll
GET /api/sessions/:sessionId/download
```

For exact payloads, see `reference.md` beside this skill.

## Safety Rules

- Treat manual web edits as source of truth; refresh state before continuing.
- Do not use private filesystem artifacts as final state. If recovery uses local media, import/write it back into SeeReel state immediately.
- Seedance references must be public or signed `http(s)` URLs. Local `/media/...` previews require TOS publish before provider use.
- Browser and CLI identities can be cookie-scoped differently on online deployments. Use handoff URLs when needed.
- Do not start paid video generation unless `seereel-canvas-review` has passed and the user approved generation.
- Poll long Seedance tasks patiently until terminal success/failure unless the user asks for recovery.

## Stage Mapping

- `seereel-script-chat` tells you what StoryPlan to save.
- `seereel-casting-assets` tells you which assets to create/import/generate and which `assetIds` are approved.
- `seereel-cinematography` tells you how to patch shots, prompts, storyboard references, and continuity fields.
- `seereel-canvas-review` tells you whether the visible canvas can proceed or which owning skill must repair it.
- `seereel-shortdrama` decides when to advance from review into render/stitch.

## Output

Return concise API results:

- session id/title and URL
- created or patched node ids
- render task ids and current status
- stitch status and download URL
- any API error with the exact endpoint and id involved
