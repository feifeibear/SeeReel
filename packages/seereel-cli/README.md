# seereelcli

Local agent CLI for creating and driving SeeReel web workflows.

The default target is `https://seereel.studio`, and you can point it at a local
server with `SEEREEL_AGENT_BASE_URL` or `--base-url`.

```bash
npm install -g ./packages/seereel-cli
seereelcli workflow "一个失眠导演在午夜便利店遇见未来的自己" --duration 60
```

From npm:

```bash
npm install -g seereelcli
seereelcli skill install --agent all
```

The package bundles the `seereel-cli` skill. `seereelcli skill install --agent all`
copies it into local Codex, Claude, Cursor, and generic `.agents` skill folders.

For deployments protected by `SEEREEL_ACCESS_TOKEN`:

```bash
seereelcli configure --base-url https://seereel.studio --access-token "$SEEREEL_ACCESS_TOKEN"
```

For browser-scoped Agent Plan generation, which is the default guided setup:

```bash
seereelcli configure --agent-plan-token "$ARK_AGENT_PLAN_KEY"
```

For standard Seedance API generation, choose a route explicitly. When BP, CN, and Agent Plan are all configured, the CLI/server use `BP > CN > Agent Plan`:

```bash
seereelcli configure --api-key "$BP_ARK_API_KEY" --api-key-route byteplus
seereelcli configure --api-key "$CN_ARK_API_KEY" --api-key-route volcengine-cn
```

Main commands:

- `seereelcli workflow "<idea>"`: create a session, generate script, and generate storyboard/workflow.
- `seereelcli workflow "<idea>" --cloud-only --reference-image ./route.png --render --stitch --output ./final.mp4`: upload user input media once, generate intermediate storyboards/shots/stitch on SeeReel, then download only the final cloud video.
- `seereelcli status --session latest --deep --json`: inspect shots, renders, errors, stitch state, and download URL.
- `seereelcli render --session latest --stitch --progress`: generate missing shots and stitch the final video with visible progress.
- `seereelcli render --session latest --stitch --stitch-partial --repair-policy safe-retry --max-attempts 2`: retry policy failures with a safer prompt and stitch ready shots.
- `seereelcli download --session latest --output ./final.mp4`: save the final video locally without custom fetch scripts.
- `seereelcli handoff --session latest --open`: create a one-time handoff link so a normal browser can claim and edit a CLI-owned session.
- `seereelcli open --session latest`: open the session URL (`/canvas/<sessionId>`).

Recommended agent flow:

```bash
seereelcli workflow "<idea>" --duration 60 --json
seereelcli status --session latest --deep --json
seereelcli render --session latest --stitch --progress --json
```

Cloud-only production flow:

```bash
seereelcli workflow "<idea>" \
  --cloud-only \
  --reference-image ./route.png \
  --duration 30 \
  --render \
  --stitch \
  --output ./final.mp4 \
  --jsonl
```

In cloud-only mode, local files are treated as user-supplied inputs only. The
CLI uploads those inputs into the SeeReel session, then creates storyboards,
shot renders, stitch output, and the final video through SeeReel server APIs.
Only the final stitched cloud artifact is downloaded to `--output`.

`workflow --json` includes `webUrl`, and online deployments also include
`handoffUrl`. Because CLI and browser identities are isolated by
`seereel_user_id` cookies online, return `handoffUrl` when a human needs to see
and continue editing the AI-created workflow in a normal browser. On localhost,
return the direct `webUrl`; local CLI sessions automatically appear in the
browser session list and do not need encrypted handoff.

Use `--jsonl` for long fully automated runs; it emits `session_created`,
`shot_submitted`, `task_id`, `poll_status`, `retrying`, and `stitch_ready`
events as newline-delimited JSON.

The CLI stores only local configuration and cookies under `~/.seereel/config.json`.
The SeeReel app remains the source of truth for sessions, shots, prompts, renders,
stitch jobs, and final videos.
