# ReelyAI Agent Guide

ReelyAI is an Agent-native short-drama production workstation. Use the agent for creative direction and automation, and use the web app as the review and manual takeover surface.

## Before Work

`npm install` runs a best-effort `postinstall` that installs the shared project skills for local agent runtimes. Refresh them manually when needed:

```bash
npm run install:skill
```

This installs every project skill under `skills/`, including:

- `reelyai-shortdrama`: end-to-end short-drama production workflow
- `reelyai-storyboard-imagegen`: Codex imagegen / `gpt-image-2` cinematic storyboard prompt workflow

For a single target:

```bash
npm run install:skill -- --agent codex
npm run install:skill -- --agent cursor
npm run install:skill -- --agent agents
```

Skip automatic postinstall writes with:

```bash
REELYAI_SKIP_SKILL_INSTALL=1 npm install
```

For a single skill:

```bash
npm run install:skill -- --skill reelyai-storyboard-imagegen
```

Then start the app:

```bash
npm run dev
```

Open the shown localhost URL. Production-style local runs often use:

```bash
NODE_ENV=production PORT=5174 npm run start
```

## Operating Model

- The agent chats with the user to shape story, casting, locations, assets, storyboards, shot prompts, and generation strategy.
- The app stores and displays scripts, beats, shots, prompts, assets, sketches, renders, stitch state, and final videos.
- The user can take over in the web UI at any point. Treat manual UI edits as source of truth.
- Keep generated intermediate results visible in the app; avoid private scratch artifacts unless they are imported afterward.

## Critical Media Rule

Seedance workers need public or signed `http(s)` URLs. Local `/media/...` paths are only for app preview. Publish Codex/imported storyboards to TOS before sending them as `reference_image`.

Use:

```text
POST /api/sessions/:sessionId/storyboards/publish-tos
```

or the web button "故事板 TOS".

## Preferred Generation Flow

1. Create/select one session per short drama.
2. Save the story plan and beats.
3. Generate or import character, scene, and storyboard references.
4. Publish local references to TOS.
5. Generate shots serially for continuity.
6. Retry polling failures before resubmitting.
7. Stitch only after all required shots are `ready`.
8. Return the final local path and browser URL.
