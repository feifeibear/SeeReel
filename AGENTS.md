# SeeReel Agent Guide

SeeReel is an Agent-native short-drama production workstation. Use the agent for creative direction and automation, and use the web app as the review and manual takeover surface.

## Before Work

This repo is framework-neutral — it works with Codex, Claude Code, Cursor, and any agent that follows the open AGENTS.md / Agent Skills standards:

- **Project context**: `AGENTS.md` (this file). `CLAUDE.md` is a symlink to it so Claude Code loads the same guide natively.
- **Skills (single source of truth)**: `.agents/skills/`, the cross-platform standard directory. Codex / Gemini / OpenCode read it as a project skill directly.

`npm install` runs a best-effort `postinstall` that mirrors the skills to every agent runtime detected on your machine. Refresh manually anytime:

```bash
npm run install:skill
```

`install:skill` auto-detects installed runtimes and copies each skill in `.agents/skills/` to that runtime's global dir (`~/.codex|.claude|.cursor|.agents/skills`), plus gitignored in-repo project mirrors for Cursor and Claude Code (`.cursor/skills/`, `.claude/skills/`). Skills shipped:

- `seereel-shortdrama`: end-to-end orchestration and stage routing
- `seereel-script-chat`: initial idea -> locked `StoryPlan`
- `seereel-casting-assets`: locked `StoryPlan` -> character/scene assets and `assetIds`
- `seereel-cinematography`: approved assets -> storyboard, shot nodes, continuity, and `rawPrompt`/`prompt`
- `seereel-canvas-review`: final canvas consistency review and fallback routing before video generation
- `seereel-storyboard-imagegen`: Codex imagegen / `gpt-image-2` cinematic storyboard reference workflow
- `seereel-agent-session`: REST-driven session control
- `seereel-cli`: local CLI workflow and fine-grained node control for AI agents

Target one or more runtimes, or force all of them:

```bash
npm run install:skill -- --agent claude        # or codex / cursor / agents (comma-separated)
npm run install:skill -- --agent all
```

Skip automatic postinstall writes with:

```bash
SEEREEL_SKIP_SKILL_INSTALL=1 npm install
```

For a single skill:

```bash
npm run install:skill -- --skill seereel-storyboard-imagegen
```

Then start the app:

```bash
npm run dev
```

Open the shown localhost URL. Production-style local runs often use:

```bash
NODE_ENV=production PORT=5174 npm run start
```

### Local Agent CLI

This repo also ships a local npm CLI package for Codex / Claude Code / Cursor Agent to create visible web workflows from natural language:

```bash
npm install -g seereelcli
seereelcli skill install --agent all
seereelcli configure --base-url https://seereel.studio --access-token "$SEEREEL_ACCESS_TOKEN"
seereelcli workflow "a short video idea in natural language" --duration 60
```

Repo-local fallback:

```bash
npm install -g ./packages/seereel-cli
npm run cli -- workflow "a short video idea in natural language" --duration 60
```

Default CLI behavior is intentionally review-first: create/select the CLI cookie-scoped user session, save the prompt as the session logline, generate the script, generate the storyboard/workflow, then return a one-time `handoffUrl` for human takeover in the browser. Raw `webUrl` links belong to the CLI cookie identity and may not be visible in a normal browser. Default credential guidance is Agent Plan, but `seereelcli configure --api-key "$BP_ARK_API_KEY" --api-key-route byteplus` and `seereelcli configure --api-key "$CN_ARK_API_KEY" --api-key-route volcengine-cn` are supported. If BP, CN, and Agent Plan are all configured, Seedance uses `BP > CN > Agent Plan`. Use `seereelcli render --session latest --stitch` only when the user explicitly wants paid video generation to continue.

## Operating Model

- The agent chats with the user to shape story, casting, locations, assets, storyboards, shot prompts, and generation strategy.
- When the user gives only a script idea, research relevant characters, plot mechanisms, and historical background before the first draft; then run script review iterations and revise until the review is satisfied before building the final review canvas. Unless the user explicitly asks for interactive discussion, work autonomously instead of stopping for preference questions.
- The app stores and displays scripts, beats, shots, prompts, assets, sketches, renders, stitch state, and final videos.
- The user can take over in the web UI at any point. Treat manual UI edits as source of truth.
- Keep generated intermediate results visible in the app; avoid private scratch artifacts unless they are imported afterward.
- Prefer full 15-second Seedance shots and pack multiple related beats inside one clip when continuity is shared; do not split every beat into a shorter video unless the story needs a real cut.
- Plan cinematic shot language before rendering: camera movement needs a story reason, blocking and screen direction must be clear, and adjacent shots should bridge through action, eyeline, reaction, insert/cutaway, sound, previous-tail, or tailframe continuity instead of feeling like unrelated clips.
- Move story-critical prompt information into audience-facing delivery: important facts should be spoken through character dialogue or voiceover/narration, with visible action or reaction as backup, rather than hidden in prompt-only lore or subtitles.
- For dialogue videos, keep one spoken language across the whole session. Default to normal diegetic sound such as dialogue, ambience, footsteps, props, and crowd noise; do not add per-shot music/BGM/score because separately generated music will not stitch continuously.
- Prefer SeeReel APIs and persisted canvas state over manual filesystem work. If an existing endpoint can create, import, publish, generate, poll, stitch, cache, or wire an artifact, use it. Manual downloads, `ffmpeg`, or file patches are recovery steps only; immediately write the result back through SeeReel APIs/state so graph edges, Inspector data, `stitchShotIds`, `referenceVideoFromShotId`, `firstFrameAssetId`, `assetIds`, renders, and `finalVideoUrl` stay auditable in the UI.

## Spec Coding

Use the project-native specs in `specs/` for non-trivial product work. Do not depend on GitHub Spec Kit or another external spec framework unless the user explicitly asks for it.

- Update the nearest long-lived spec before changing user-visible behavior, generation state, release behavior, observability, persistence, API contracts, or agent workflows.
- Skip specs for narrow fixes that do not change product rules, such as typo fixes, obvious broken imports, stale copy commands, and dependency lockfile cleanup.
- Prefer updating an existing spec over creating one-off documents.
- Implementation must map back to the spec's acceptance criteria.
- Verification must include `npm run smoke:specs` and, before release, `npm run verify:offline`.
- If code and spec disagree, resolve the disagreement in the same change.
- In the final response or PR, name the spec that governed the change and call out any acceptance criteria that could not be verified.

### Secret Safety

Never upload AK/SK, tokens, passwords, API keys, private keys, admin credentials, or provider secrets to GitHub, online APIs, frontend bundles, logs, dashboards, screenshots, or any public surface. Use protected runtime configuration and masked status displays. Run `npm run smoke:secrets` when touching credentials, diagnostics, metrics, deployment, or admin settings.

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
