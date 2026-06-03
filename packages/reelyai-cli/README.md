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
- `reelyai render --session latest --stitch`: generate missing shots and stitch the final video.
- `reelyai status`: list recent sessions in the configured user cookie scope.
- `reelyai open --session latest`: open the session URL (`#/s/<sessionId>`).

The CLI stores only local configuration and cookies under `~/.reelyai/config.json`.
The ReelyAI app remains the source of truth for sessions, shots, prompts, renders,
stitch jobs, and final videos.
