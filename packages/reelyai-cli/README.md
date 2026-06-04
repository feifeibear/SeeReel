# reelyai

Local agent CLI for creating and driving ReelyAI web workflows.

The default target is `https://reelyai.app`, and you can point it at a local
server with `REELYAI_AGENT_BASE_URL` or `--base-url`.

```bash
npm install -g ./packages/reelyai-cli
reelyai workflow "一个失眠导演在午夜便利店遇见未来的自己" --duration 60
```

From npm:

```bash
npm install -g reelyai
reelyai skill install --agent all
```

The package bundles the `reelyai-cli` skill. `reelyai skill install --agent all`
copies it into local Codex, Claude, Cursor, and generic `.agents` skill folders.

For deployments protected by `REELYAI_ACCESS_TOKEN`:

```bash
reelyai configure --base-url https://reelyai.app --access-token "$REELYAI_ACCESS_TOKEN"
```

For browser-scoped Agent Plan generation:

```bash
reelyai configure --agent-plan-token "$ARK_AGENT_PLAN_KEY"
```

Main commands:

- `reelyai workflow "<idea>"`: create a session, generate script, and generate storyboard/workflow.
- `reelyai status --session latest --deep --json`: inspect shots, renders, errors, stitch state, and download URL.
- `reelyai render --session latest --stitch --progress`: generate missing shots and stitch the final video with visible progress.
- `reelyai render --session latest --stitch --stitch-partial --repair-policy safe-retry --max-attempts 2`: retry policy failures with a safer prompt and stitch ready shots.
- `reelyai download --session latest --output ./final.mp4`: save the final video locally without custom fetch scripts.
- `reelyai handoff --session latest --open`: create a one-time handoff link so a normal browser can claim and edit a CLI-owned session.
- `reelyai open --session latest`: open the session URL (`#/s/<sessionId>`).

Recommended agent flow:

```bash
reelyai workflow "<idea>" --duration 60 --json
reelyai status --session latest --deep --json
reelyai render --session latest --stitch --progress --json
```

`workflow --json` includes both `webUrl` and `handoffUrl`. Because CLI and
browser identities are isolated by `reelyai_user_id` cookies, return `handoffUrl`
when a human needs to see and continue editing the AI-created workflow in a
normal browser. The raw `webUrl` is still useful inside the CLI cookie scope.

Use `--jsonl` for long fully automated runs; it emits `session_created`,
`shot_submitted`, `task_id`, `poll_status`, `retrying`, and `stitch_ready`
events as newline-delimited JSON.

The CLI stores only local configuration and cookies under `~/.reelyai/config.json`.
The ReelyAI app remains the source of truth for sessions, shots, prompts, renders,
stitch jobs, and final videos.
