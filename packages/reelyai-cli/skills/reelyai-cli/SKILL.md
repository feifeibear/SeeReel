---
name: reelyai-cli
description: Use the local SeeReel CLI to create, inspect, edit, render, review, repair, and stitch web-visible SeeReel video workflows from natural language. Trigger when the user asks an AI agent to use SeeReel, seereel.studio, the SeeReel CLI, generate a web workflow, operate a shot/node prompt, generate a tailframe, run VLM review, repair prompts, publish storyboards to TOS, or produce a complete video through the site.
---

# SeeReel CLI

Use this skill when the user wants an AI agent to operate SeeReel through the local CLI instead of manually clicking the web UI.

SeeReel has two surfaces:

- Web app: human review and takeover surface.
- CLI/API: agent operation surface. Everything important must remain visible in the web app.

## Human Credential Boundary

Do not invent, request from hidden memory, scrape, or expose API keys.

For real generation, the human must:

1. Open/pay for Volcengine Agent Plan.
2. Create an Agent Plan API key in Ark.
3. Paste it into the SeeReel web top-bar Agent Plan control for browser/manual work.
4. For CLI automation, either run:

```bash
seereelcli configure --base-url https://seereel.studio --agent-plan-token "<human-pastes-key-here>"
```

or set `SEEREEL_AGENT_PLAN_TOKEN` / `ARK_AGENT_PLAN_KEY` in the AI runtime environment.

Browser credentials and CLI credentials are cookie-scoped separately. Treat that isolation as intentional. A raw `webUrl` belongs to the CLI cookie scope; return `handoffUrl` when a human needs to open and continue editing the AI-created workflow in a normal browser.

## Install

If the npm package is published:

```bash
npm install -g seereelcli
seereelcli skill install --agent all
```

The npm package bundles this skill. `seereelcli skill install --agent all` copies it into local Codex, Claude, Cursor, and generic `.agents` skill folders. `seereelcli skill print` prints the bundled `SKILL.md` when an agent needs to read or mirror it manually.

Current repo-local install:

```bash
git clone https://github.com/feifeibear/seereel-agent.git
cd seereel-agent
npm install
npm install -g ./packages/reelyai-cli
seereelcli --help
```

From repo root without global install:

```bash
npm run cli -- --help
```

## Configure

Default base URL is `https://seereel.studio`.

```bash
seereelcli configure --base-url https://seereel.studio
```

If the deployment requires a shared access token:

```bash
seereelcli configure --access-token "$SEEREEL_ACCESS_TOKEN"
```

For local development:

```bash
seereelcli configure --base-url http://localhost:5173
```

## Review-First Default Flow

Default: create a visible workflow, then stop for human review.

```bash
seereelcli workflow "一个失眠导演在午夜便利店遇见未来的自己" \
  --duration 60 \
  --style "neo-noir, rain reflections, grounded sci-fi" \
  --json
```

Return the one-time `handoffUrl` to the user, not the raw `webUrl`. It should look like:

```text
https://seereel.studio/api/handoff/xxxxxxxx
```

Tell the human the handoff link transfers the session from the CLI cookie identity to their current browser identity, then they can edit script, shot prompts, assets, duration, references, and generation choices in the web UI. After a handoff is claimed, keep using the browser/web UI as source of truth unless the human asks you to continue from a CLI-owned session.

## Full Video Flow

Only continue after the human confirms Agent Plan is configured and the workflow is acceptable.

```bash
seereelcli status --session latest --deep --json
seereelcli render --session latest --stitch --progress --json
```

If the human explicitly asks for full automation:

```bash
seereelcli workflow "用户的视频创意" --duration 60 --render --stitch --jsonl
```

Report the final `downloadUrl`. If a shot fails, report the shot id and failure; do not silently skip it.
Use `--stitch-partial` only when the human accepts a shorter cut made from ready shots:

```bash
seereelcli render --session latest --stitch --stitch-partial --progress --json
```

For policy failures or stuck renders, use the recovery loop before asking the human to intervene:

```bash
seereelcli status --session latest --deep --json
seereelcli node poll --id shot_xxxxxxxx --json
seereelcli node update-prompt --id shot_xxxxxxxx --prompt "safer Seedance prompt" --duration 8 --json
seereelcli render --session latest --repair-policy safe-retry --max-attempts 2 --stitch-partial --progress --json
```

`--jsonl` emits agent-readable progress events such as `session_created`, `shot_submitted`, `task_id`, `poll_status`, `retrying`, and `stitch_ready`.

Download the final video through the CLI instead of writing a private fetch script:

```bash
seereelcli download --session latest --output ./final.mp4
```

## Node Operations

Inspect one node:

```bash
seereelcli node get --id shot_xxxxxxxx --json
seereelcli node get --id asset_xxxxxxxx --json
seereelcli node get --id ses_xxxxxxxx --json
```

Update a video node prompt:

```bash
seereelcli node update-prompt --id shot_xxxxxxxx \
  --prompt "新的 Seedance 视频 prompt，保留角色服装和场景连续性" \
  --title "03 重新追上自己" \
  --duration 15 \
  --json
```

Generate or poll one video node:

```bash
seereelcli node generate --id shot_xxxxxxxx --wait --json
seereelcli node poll --id shot_xxxxxxxx --json
```

Generate a rendered shot tailframe:

```bash
seereelcli node tailframe --id shot_xxxxxxxx --publish-tos --canvas-node --json
```

Use `--publish-tos` when the tailframe will be used as a Seedance reference. Seedance cannot fetch local `/media/...` URLs.

Open VLM review and repair:

```bash
seereelcli node review --id shot_xxxxxxxx --frame-count 8 --json
seereelcli node repair --id shot_xxxxxxxx --json
seereelcli final-review --session latest --json
seereelcli final-review --session latest --repair --json
```

Operate asset nodes:

```bash
seereelcli node update-prompt --id asset_xxxxxxxx --prompt "角色参考图 prompt" --json
seereelcli node generate --id asset_xxxxxxxx --model seedream-5-lite --json
seereelcli node review --id asset_xxxxxxxx --json
```

Publish storyboard references to TOS:

```bash
seereelcli publish-storyboards --session latest --json
```

## Rules

- Prefer CLI/API over browser automation.
- Always use `--json` when you need to parse results.
- Use `--jsonl` or `--progress` for long render/stitch runs so the agent can observe progress without polling `/api/state` in another shell.
- Refresh status before continuing after a human web edit.
- Browser credentials and CLI credentials are cookie-scoped separately. Raw `webUrl` may not be visible in a bare browser; use `seereelcli handoff --session latest --json` and return the one-time `handoffUrl` for human takeover.
- Do not call paid generation before Agent Plan is configured and the human has approved continuing.
- Keep local scratch media out of the final story; SeeReel web state is the source of truth.
- For Seedance references, only remote `http(s)` URLs are valid. Publish local references to TOS first.
