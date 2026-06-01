# Agent-Native Short Drama Workflow

ReelyAI positions the web app as a production state layer for short-drama agents.

The intended user experience is conversational first: the creator works with Codex, Cursor Agent, Claude Code, or another agent framework to develop the short drama. The agent can brainstorm story, cast roles, generate visual references, import assets, publish references, submit Seedance shots, recover failures, and stitch the final cut. The web app remains open as the inspectable production board.

## Roles

Agent:

- expands a loose idea into premise, synopsis, characters, beats, and shots
- chooses when to use Codex imagegen, Seedream, or imported references
- calls ReelyAI APIs and scripts to keep the app state current
- handles long-running Seedance generation, polling, retries, and stitching

Web app:

- displays scripts, beats, shots, prompts, assets, references, renders, and final output
- lets the human edit prompts, adjust durations, import sketches, publish TOS references, run shots, delete renders, or stitch manually
- acts as the shared source of truth between human and agent

Skills:

- package the workflow so a new agent runtime can learn the project quickly
- keep operational rules close to the repo instead of buried in chat history
- make Codex imagegen and future image providers usable through the same import/publish/render chain

## Skill installation

Run before using an agent against this repo:

```bash
npm run install:skill
```

`skills/` is the single source for every project skill. The installer copies each one
(`reelyai-shortdrama`, `reelyai-storyboard-imagegen`, `reelyai-script-chat`, `reelyai-agent-session`) to:

- `~/.codex/skills/<skill>`
- `~/.cursor/skills/<skill>`
- `~/.agents/skills/<skill>`

`reelyai-agent-session` is additionally synced into the repo's own `.cursor/skills/` so Cursor auto-loads it as a project skill. That in-repo copy is generated and gitignored — always edit the version under `skills/`.

Use `--agent codex`, `--agent cursor`, or `--agent agents` to install only one target.
Use `--skill reelyai-storyboard-imagegen` to install only the storyboard skill.

## Image generation provider shape

All image providers should normalize into the same downstream flow:

```text
image provider -> local media file or data URL -> ReelyAI asset/sketch import -> TOS publish -> Seedance reference_image
```

Codex imagegen is one provider. Seedream, OpenAI, Liblib, or internal image services can use the same path as long as they produce an image that can be imported into ReelyAI.

For one Seedance shot, prefer this storyboard sequence:

```text
shot script -> 3x3 cinematic storyboard contact sheet -> human approval -> clean keyframe/upscaled panel -> ReelyAI import -> TOS publish -> Seedance generation
```

The contact sheet is best for planning and review. A clean keyframe is usually better as a direct Seedance `reference_image`.

## Guardrails

- Do not send local `/media/...` references to Seedance.
- Compress large storyboards before publishing if Seedance fetches time out.
- Treat expired signed URLs as broken references; republish or remove the asset from the shot.
- Generate shots serially when continuity matters.
- Retry stitch before regenerating shots when download normalization fails.
