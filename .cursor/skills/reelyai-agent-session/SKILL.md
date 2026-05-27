---
name: reelyai-agent-session
description: Drives reelyai-agent short-film sessions through the web app REST API. Use when the user mentions reelyai-agent, cinema agent, 短片制作, session, 分镜, shot, Seedance, 资产库, 自动产片, or 拼接视频, especially when Codex should create a session, plan shots, generate Seedance videos, or stitch a final video visible in the web UI.
---

# reelyai-agent Session

## Positioning

reelyai-agent is a dual-entry short-film production workspace:

- Humans use the web app to inspect, edit, and debug sessions, shots, assets, prompts, renders, and final videos.
- Codex uses this skill to drive the same sessions through the REST API, so all AI-created intermediate results remain visible and editable in the web app.

Do not use libtv for this workflow. Use only the reelyai-agent web/API surface and the providers wired into the project, including Seedance, Seedream, and OpenAI.

## Defaults

- Base URL: `process.env.REELYAI_AGENT_BASE_URL || process.env.CINEMA_AGENT_BASE_URL || "http://localhost:5173"`.
- Default automation mode: staged confirmation.
- First pass: create session, generate script, then stop and ask the user to review/edit in the web UI.
- Continue only after the user confirms generation or explicitly asks to continue.
- Asset policy: reuse existing assets first. Use `@资产名` mentions in prompts when possible; create and generate new assets only when key characters, scenes, or props are missing.
- Shot duration: Seedance supports at most 15 seconds per shot. For a requested total duration, choose `shotCount >= Math.ceil(targetDurationSec / 15)`.
- Continuity: when generating shot 2+, prefer `usePreviousShotClip: true` and `previousShotClipSec: 2`; this uses reference-video continuity, not first/last-frame mode.
- First-frame anchoring (shot 1, optional): if the user clearly wants the opening shot to start FROM a specific image — phrases like "以 @资产 为首帧 / 开场 / 起手画面 / 第一帧", "shot 1 从这张图动起来", "完全照这张图的构图", or the user pinned a strongly composed image (movie poster, meme frame, product hero shot, storyboard panel) as the opening anchor — `PATCH /api/shots/:shotId` with `{ "firstFrameAssetId": "asset_xxx" }` on shot 1 before calling generate. Mutually exclusive constraints per BytePlus Seedance docs:
  - First-frame mode drops ALL `reference_image` / `reference_video` / `reference_audio` from the payload; the server enforces this. So shot 1 should not also have `usePreviousShotClip` (it doesn't anyway for shot 1) and any other `@资产` mentioned in the prompt will only appear as text, not as reference media.
  - The target asset MUST have a public `mediaUrl` starting with `http(s)://` (Seedream-generated TOS URL, etc.). Local `/media/...` paths cannot be used as first frame; if the candidate asset only has a local file, run Seedream image generation on it first so it gets uploaded to a remote URL.
  - This is a shot-1 optimization. Do not apply it to shot 2+ unless the user explicitly asks; for shot 2+, continuity reference is the default.

## Workflow

1. Check service health:
   - `GET /api/state`
   - If unavailable, tell the user to start the app with `npm run dev`, or set `REELYAI_AGENT_BASE_URL` to the running service.

2. Create or select a session:
   - For new work, `POST /api/sessions` with `title`, `logline`, `style`, `targetDurationSec`, and `shotCount`.
   - If the user wants the newest session, use the first item from `GET /api/state`.
   - If the user names an existing session, match by title from `GET /api/state`.

3. Prepare assets:
   - Inspect `assets` from `GET /api/state`.
   - Reuse matching assets by name or tags.
   - If a needed asset is missing, create it with `POST /api/assets`; for image references, call `POST /api/assets/:assetId/generate` with `{"model":"seedream-4"}` unless the user asks for `gpt-image-2`.
   - Mention reused/generated assets in shot prompts with `@资产名` so the server resolves reference media.

4. Generate script, then pause:
   - `POST /api/sessions/:sessionId/script/generate`
   - Return the session title, web URL, premise, synopsis, and beat list.
   - Tell the user they can edit the script panel, lock the script, adjust beats, and add `@资产名` references in the web UI.

5. After confirmation, run storyboard from script:
   - `POST /api/sessions/:sessionId/storyboard`
   - The API uses `session.story.beats` when present; otherwise it falls back to logline planning.
   - Return a compact shot list with index, title, duration, status, and prompt.
   - Tell the user they can still edit assets, prompts, seconds, and "参考上一个分镜" in the web UI before generation.

6. After confirmation, generate shots:
   - Shot 1 special (optional): if first-frame anchoring applies (see Defaults), confirm the chosen asset has a public `http(s)` `mediaUrl`; if it only has a local `/media/...` URL, generate the asset image first (`POST /api/assets/:assetId/generate` with `{"model":"seedream-4"}`) so it gets a remote URL. Then `PATCH /api/shots/:shotId` with `{"firstFrameAssetId":"asset_xxx"}` and leave `usePreviousShotClip` false. The server will automatically strip all other reference media for this shot.
   - For shot 2+, patch continuity before generation:
     `PATCH /api/shots/:shotId` with `{"usePreviousShotClip":true,"previousShotClipSec":2}`.
   - `POST /api/shots/:shotId/generate`
   - Poll each shot with `POST /api/shots/:shotId/poll` until status is `ready`, `error`, or `cancelled`.
   - Continue sequentially when continuity matters; only parallelize independent shots.

7. Stitch final video:
   - If any shot is `error` or lacks `videoUrl`, do not stitch. Report failed shots and recommend retrying those shots first.
   - When ready, `POST /api/sessions/:sessionId/stitch`. This call is fire-and-forget and returns immediately with `stitchStatus = ready | running | error` (cache hit returns `ready` in milliseconds). Do NOT hold a long fetch on this endpoint; client disconnects no longer affect the underlying ffmpeg work.
   - If `stitchStatus = running`, poll `POST /api/sessions/:sessionId/stitch/poll` every ~3s until `stitchStatus = ready` (success) or `error` (read `stitchError` and either retry or report). `stitchProgress` is a human-readable phase like `"downloading shot 4/5"` or `"ffmpeg concat (libx264 ...)"`.
   - The job is singleflight per session: re-posting `/stitch` while a worker is already running on the same input signature returns the same in-flight snapshot, not a duplicate run. On server restart, any `running` job is automatically marked `error: "Server restarted while stitching"` so the next `/stitch` call cleanly retries.
   - Return the web URL and download URL: `/api/sessions/:sessionId/download`.

## Output Format

After script:

```markdown
已创建 Session: [title]
Web: [baseUrl]

剧本:
Premise: [premise]
Synopsis: [synopsis]

节拍:
1. [title] - [duration]s
   [plot]

请在 Web 端检查/编辑剧本、节拍和 @资产引用；确认后我再继续生成分镜。
```

After storyboard:

```markdown
已生成分镜: [title]
Web: [baseUrl]

分镜:
1. [title] - [duration]s - [status]
   Prompt: [prompt]

请在 Web 端检查/编辑资产、prompt、秒数和参考上一个分镜；确认后我再继续生成视频并拼接。
```

After final stitch:

```markdown
完成: [title]
Web: [baseUrl]
下载: [baseUrl]/api/sessions/[sessionId]/download

Shot 状态:
1. [title] - ready
```

## Reference

For endpoint details and example payloads, see [reference.md](reference.md).
