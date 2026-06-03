---
name: reelyai-cli
description: Use the local ReelyAI CLI to create, inspect, edit, render, review, repair, and stitch web-visible ReelyAI video workflows from natural language. Trigger when the user asks an AI agent to use ReelyAI, reelyai.app, the ReelyAI CLI, generate a web workflow, operate a shot/node prompt, generate a tailframe, run VLM review, repair prompts, publish storyboards to TOS, or produce a complete video through the site.
---

# ReelyAI CLI

Use this skill when the user wants an AI agent to operate ReelyAI through the local CLI instead of manually clicking the web UI.

ReelyAI has two surfaces:

- Web app: human review and takeover surface.
- CLI/API: agent operation surface. Everything important must remain visible in the web app.

## Human Credential Boundary

Do not invent, request from hidden memory, scrape, or expose API keys.

For real generation, the human must:

1. Open/pay for Volcengine Agent Plan.
2. Create an Agent Plan API key in Ark.
3. Paste it into the ReelyAI web top-bar Agent Plan control for browser/manual work.
4. For CLI automation, either run:

```bash
reelyai configure --base-url https://reelyai.app --agent-plan-token "<human-pastes-key-here>"
```

or set `REELYAI_AGENT_PLAN_TOKEN` / `ARK_AGENT_PLAN_KEY` in the AI runtime environment.

Browser credentials and CLI credentials are cookie-scoped separately. Treat that isolation as intentional.

## Install

If the npm package is published:

```bash
npm install -g reelyai
reelyai skill install --agent all
```

The npm package bundles this skill. `reelyai skill install --agent all` copies it into local Codex, Claude, Cursor, and generic `.agents` skill folders. `reelyai skill print` prints the bundled `SKILL.md` when an agent needs to read or mirror it manually.

Current repo-local install:

```bash
git clone https://github.com/feifeibear/reelyai-agent.git
cd reelyai-agent
npm install
npm install -g ./packages/reelyai-cli
reelyai --help
```

From repo root without global install:

```bash
npm run cli -- --help
```

## Configure

Default base URL is `https://reelyai.app`.

```bash
reelyai configure --base-url https://reelyai.app
```

If the deployment requires a shared access token:

```bash
reelyai configure --access-token "$REELYAI_ACCESS_TOKEN"
```

For local development:

```bash
reelyai configure --base-url http://localhost:5173
```

## Review-First Default Flow

Default: create a visible workflow, then stop for human review.

```bash
reelyai workflow "一个失眠导演在午夜便利店遇见未来的自己" \
  --duration 60 \
  --style "neo-noir, rain reflections, grounded sci-fi" \
  --json
```

Return the `webUrl` to the user. It should look like:

```text
https://reelyai.app/#/s/ses_xxxxxxxx
```

Tell the human they can edit script, shot prompts, assets, duration, references, and generation choices in the web UI.

## Full Video Flow

Only continue after the human confirms Agent Plan is configured and the workflow is acceptable.

```bash
reelyai render --session latest --stitch --json
```

If the human explicitly asks for full automation:

```bash
reelyai workflow "用户的视频创意" --duration 60 --render --stitch --json
```

Report the final `downloadUrl`. If a shot fails, report the shot id and failure; do not silently skip it.

## Node Operations

Inspect one node:

```bash
reelyai node get --id shot_xxxxxxxx --json
reelyai node get --id asset_xxxxxxxx --json
reelyai node get --id ses_xxxxxxxx --json
```

Update a video node prompt:

```bash
reelyai node update-prompt --id shot_xxxxxxxx \
  --prompt "新的 Seedance 视频 prompt，保留角色服装和场景连续性" \
  --title "03 重新追上自己" \
  --duration 15 \
  --json
```

Generate or poll one video node:

```bash
reelyai node generate --id shot_xxxxxxxx --wait --json
reelyai node poll --id shot_xxxxxxxx --json
```

Generate a rendered shot tailframe:

```bash
reelyai node tailframe --id shot_xxxxxxxx --publish-tos --canvas-node --json
```

Use `--publish-tos` when the tailframe will be used as a Seedance reference. Seedance cannot fetch local `/media/...` URLs.

Open VLM review and repair:

```bash
reelyai node review --id shot_xxxxxxxx --frame-count 8 --json
reelyai node repair --id shot_xxxxxxxx --json
reelyai final-review --session latest --json
reelyai final-review --session latest --repair --json
```

Operate asset nodes:

```bash
reelyai node update-prompt --id asset_xxxxxxxx --prompt "角色参考图 prompt" --json
reelyai node generate --id asset_xxxxxxxx --model seedream-5-lite --json
reelyai node review --id asset_xxxxxxxx --json
```

Publish storyboard references to TOS:

```bash
reelyai publish-storyboards --session latest --json
```

## Rules

- Prefer CLI/API over browser automation.
- Always use `--json` when you need to parse results.
- Refresh status before continuing after a human web edit.
- Do not call paid generation before Agent Plan is configured and the human has approved continuing.
- Keep local scratch media out of the final story; ReelyAI web state is the source of truth.
- For Seedance references, only remote `http(s)` URLs are valid. Publish local references to TOS first.
