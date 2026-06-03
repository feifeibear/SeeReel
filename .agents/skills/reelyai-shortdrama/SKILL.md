---
name: reelyai-shortdrama
description: Drive ReelyAI as an Agent-native short-drama production workstation. Use when creating, planning, storyboarding, generating assets, publishing references, rendering Seedance shots, stitching final videos, or when the user mentions ReelyAI, cinema_agent, short drama, 短剧, 分镜, 故事板, 参考图, ToS, Seedance, or Codex imagegen workflow.
---

# ReelyAI Short Drama

## Product stance

Treat ReelyAI as an Agent-native short-drama production workstation, not just a web video tool.

- The agent is the creative producer and operator: discuss story, cast characters, plan scenes, generate assets, import references, publish media, submit Seedance tasks, retry failures, and stitch the final cut.
- The web app is the review and human takeover surface: it displays scripts, beats, shots, prompts, assets, sketches, renders, status, and final videos; the user can edit or run any step manually.
- Intermediate artifacts must stay inspectable in the app. Prefer saving state through the local API over one-off files that the UI cannot see.
- API-first rule: when ReelyAI has an endpoint or persisted state field for a step, use it instead of private shell/file operations. Do not bypass graph semantics by manually stitching, patching final files, or writing hidden local artifacts unless recovering from a failure; if recovery is unavoidable, immediately bring the artifact back through ReelyAI API/state (for example `shot.videoUrl`, `renders`, `session.stitchShotIds`, `stitchJobs[].shotIds`, `referenceVideoFromShotId`, `firstFrameAssetId`, `assetIds`, and `finalVideoUrl`) so the human can inspect and take over.

## Standard flow

1. Ensure the app is running.
   - Development: `npm run dev`
   - Production preview: `NODE_ENV=production PORT=5174 npm run start`
   - On this host, use Node 22 in `PATH` if build/dev has Rollup native module issues.
2. Create or select a session. A short drama is one session.
   - **When the user starts from a reference video, do NOT bare-create with `POST /api/sessions` and hand-append shots.** Use the built-in reference-video analysis workflow: `POST /api/assets/upload-video` → `POST /api/assets/:assetId/analyze-video` to populate `asset.parsedShots`, then in the Flow canvas apply parsed entries onto session shots from the reference-video Inspector. The same asset can also be bound as `referenceVideoAssetId` when the user wants Seedance to follow the clip's motion/framing as a licensed or self-owned reference.
   - Bare `POST /api/sessions` is only the right entry when the user is starting from a written premise/script with no reference video.
3. Work with the user in chat to shape the premise, characters, tone, shot count, and duration.
   - **Default cadence: prefer fewer, longer shots.** A 60s short drama defaults to **4 shots × 15s** (Seedance 2.0 supports up to 15s per generation). Long shots make character + scene consistency easier and reduce cut-induced drift. Only break a shot into shorter segments when the action genuinely demands a hard cut (e.g. POV change, time jump, location change).
   - Inside each long shot, plan a beat timeline (`0-3s … / 3-7s … / 7-12s … / 12-15s …`). Pass that timeline through to the Seedance prompt so the model paces correctly. The companion `seedance-prompt-craft` skill has the full 6-element template.
   - **Vibe Creating for narrative shorts:** for mood/poetic/character-driven shorts, prefer story-expression prompts over over-specified production commands. Keep the user's intent, enrich situation, emotion, atmosphere, memory, and sensory detail; remove unnecessary focal-length/F-stop/camera-speed parameter chatter unless it directly serves the emotion. A strong prompt should carry four layers: visual anchor, subject action/state, local tone/light/rhythm, and the video's overall theme/style.
   - **Continuity bible before generation:** when a user complains about inconsistent shots, write a short repeated continuity paragraph before every shot prompt: exact character design, fixed wardrobe/material/color, recurring prop/visual motif, global color grade, and explicit negatives for drift. Also create session-scoped character/style reference assets and bind them in every shot's `assetIds` when possible.
4. Save the story plan and shots through app APIs or existing scripts so the web app reflects the work.
5. Generate or import reference images.
   - Use Codex imagegen when available for high-quality storyboards or character/scene references.
   - For cinematic storyboard contact sheets, follow the companion `reelyai-storyboard-imagegen` skill.
   - Import images into shot sketches with `POST /api/shots/:shotId/sketches/import`.
   - **Storyboard-as-reference (preferred for long shots):** generate a per-shot 2×2 storyboard image whose four panels encode the in-shot beats (`0-3s / 3-7s / 7-12s / 12-15s`), and attach it as a regular `reference_image` (NOT as `firstFrameAssetId`). The new `POST /api/shots/:shotId/storyboard-ref` route handles this end-to-end with VLM iteration. First-frame mode is mutually exclusive with reference_image attachments — only use first-frame when you genuinely need a locked opening composition (e.g. a single-character close-up).
   - Keep sketches shot-scoped unless the user explicitly wants a reusable global asset.
6. Publish local references before video generation.
   - Remote Seedance cannot consume local `/media/...` URLs.
   - Use `POST /api/sessions/:sessionId/storyboards/publish-tos` or the web button "故事板 TOS".
   - If using private TOS buckets, leave `TOS_PUBLIC_BASE_URL` empty so ReelyAI stores pre-signed URLs.
   - Seedream-4.5 generations come back with public TOS https URLs already; storyboard-ref images created via the new route do not need a separate publish-tos step.
7. Generate shots serially unless the user explicitly asks for parallel generation.
   - For continuity, let shot N+1 wait until shot N is ready.
   - Preserve "参考上一个分镜" semantics: use the full previous shot by default unless the user overrides duration; cap to the previous shot duration.
8. Stitch after every required shot is `ready`.
   - Use `POST /api/sessions/:sessionId/stitch`.
   - Preserve stitch wiring through `session.stitchShotIds` or stitch-job `shotIds`; final videos should be produced by `/stitch` whenever possible, not by manual `ffmpeg` outside the app.
   - If stitching fails while downloading remote video, retry stitch before regenerating shots.
9. Return the local final video path and browser URL.

## Human takeover rules

- If the user edits prompt, duration, assets, or first-frame settings in the web app, treat that as source of truth.
- Do not overwrite manual edits unless the user asks for regeneration or a specific replacement.
- Use the UI as a review surface: after large changes, tell the user what they can inspect in the browser.

## Multi-shot consistency playbook

Use this playbook for original multi-shot shorts, especially after a result has inconsistent task, character, or style.

1. **Pick one continuous task spine.** Do not make each shot a separate idea. Give the protagonist one repeated action or motif that evolves across shots (for example, carrying one red thread through the city). Put that spine in the story `theme`, every beat, and every shot prompt.
2. **Write Vibe-style prompts, not parameter dumps.** Describe the situation, emotional pressure, atmosphere, and sensory details as a short literary scene. Keep only camera language that tells the model how the viewer should feel ("the view slowly moves closer, making the office feel trapping"), not bare execution parameters ("85mm f/1.4, speed 0.7x") unless the user needs industrial precision.
3. **Repeat a continuity bible verbatim.** Start every Seedance prompt with the same 2–4 sentence bible for: protagonist design, recurring prop, world/style, palette, and negative drift constraints. This is more reliable than assuming the model remembers previous prompts.
4. **Use shared reference assets across all shots.** Generate or import at least one session-scoped character reference and one style/world reference, publish/verify remote `https` URLs, and bind both IDs in every shot's `assetIds`. Avoid per-shot storyboard grids if they overpower the global style or force different character designs.
5. **Choose one continuity mode, don't stack mutually exclusive modes.** In this app, `firstFrameAssetId` and `subShotStoryboardAssetId` suppress normal reference-image / previous-shot continuity paths. For a 4×15s narrative short, the safest default is: shared `assetIds` on every shot + `usePreviousShotClip: true` from shot 2 onward. Use first-frame only when the opening composition matters more than reference images; use sub-shot grid only when in-shot beat layout matters more than previous-shot motion continuity.
6. **Generate serially and inspect before stitching.** Let shot N finish before shot N+1. If a shot drifts badly in character/style, regenerate that shot before continuing; do not stitch a visibly broken chain.

## Reference image rules

- Only send remote `http(s)` media URLs to Seedance.
- Treat expired TOS/Ark signed URLs as broken references. If a referenced asset returns `403` or times out, republish it or remove it from `assetIds` and keep the description in text.
- Codex imagegen storyboards should usually be compressed before ToS publish when Seedance fetches time out.
- Keep `first_frame` mode separate from generic `reference_image` mode. Do not mix first-frame/last-frame payloads with generic reference media in the same request.

## Reference-video remake (Seedance `reference_video`)

ReelyAI lets a shot bind one whole video as Seedance's `reference_video` slot. The model will follow that clip's motion, framing, and pacing while the prompt drives subject and style. Use this for the user's own footage, licensed B-roll, agent-generated test patterns, or a previously-rendered ReelyAI shot you want to reframe — never for third-party copyrighted footage being repurposed via character substitution.

Mode mutual exclusivity (server enforces this in `submitShotGeneration`): reference-video > sub-shot grid > first/last-frame. Setting `referenceVideoAssetId` automatically wins over previous-shot continuity for that shot.

Four steps end-to-end:

1. **Upload the video as an Asset.** Raw bytes, content-type `video/*`:
   ```bash
   curl -X POST "$BASE/api/assets/upload-video?ownerSessionId=$SID&filename=clip.mp4" \
     -H 'Content-Type: video/mp4' --data-binary @clip.mp4
   ```
   - The endpoint writes locally, then auto-publishes to TOS if `hasTosConfig()` returns true. **The server process must have `TOS_ACCESS_KEY_ID / TOS_SECRET_ACCESS_KEY / TOS_REGION / TOS_BUCKET` in its environment** — `dotenv/config` loads them from `.env` only if the file is present at server cwd. If the resulting `asset.mediaUrl` starts with `/media/...`, TOS is misconfigured and Seedance won't be able to fetch the file; restart the server with the env loaded.
   - Verify `asset.mediaKind === "video"` and `asset.mediaUrl` is `https://...`.

2. **Bind the asset to a shot:**
   ```bash
   curl -X PATCH "$BASE/api/shots/$SHOT" -H 'Content-Type: application/json' \
     -d "{\"referenceVideoAssetId\":\"$ASSET\"}"
   ```
   The Flow Inspector also exposes a per-shot toggle (`src/client/flow/Inspector.tsx`, panel "用作视频参考(Seedance reference_video)").

3. **Generate as usual.** `POST /api/shots/:shotId/generate` — the generate path resolves `useReferenceVideoMode` and passes `mediaUrl` through to Seedance with `role: "reference_video"`. The render snapshot stores `referenceVideoAssetId` so the audit trail is intact.

4. **Stitch when ready.** Standard `POST /api/sessions/:sessionId/stitch`.

Verification quick-check after a render lands: pull the render record from `/api/state` and confirm `renders[-1].referenceVideoAssetId` matches the bound asset id. If absent, the shot fell back to a different mode (most common cause: a `firstFrameAssetId` or `subShotStoryboardAssetId` is also set on the same shot, and one of those took precedence).

## Useful API endpoints

- `GET /api/state`
- `POST /api/sessions`
- `PATCH /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/script/generate`
- `PATCH /api/sessions/:sessionId/script`
- `POST /api/sessions/:sessionId/storyboard`
- `POST /api/sessions/:sessionId/storyboards/publish-tos`
- `POST /api/assets/upload-video` ← raw video bytes; auto-publishes to TOS for `referenceVideoAssetId` use
- `PATCH /api/shots/:shotId` ← whitelist includes graph/audit fields such as `referenceVideoAssetId`, `referenceVideoFromShotId`, `firstFrameAssetId`, `assetIds`, and previous-shot continuity controls
- `POST /api/shots/:shotId/sketches/import`
- `POST /api/shots/:shotId/storyboard-ref` ← per-shot 2×2 plot-beat reference, VLM-iterated, attached as `reference_image`
- `POST /api/shots/:shotId/generate`
- `POST /api/shots/:shotId/poll`
- `POST /api/sessions/:sessionId/stitch`
- `POST /api/sessions/:sessionId/stitch-jobs`
- `PATCH /api/sessions/:sessionId/stitch-jobs/:jobId`
- `POST /api/sessions/:sessionId/stitch/poll`

## Failure handling

- `content[n].image_url timeout/resource download failed`: compress and republish the image to TOS, or remove the expired reference asset and retry.
- `fetch failed` during polling: retry polling the same task; do not submit a duplicate until state proves there is no active task.
- Stitch download failure: retry stitch. The app caches successfully downloaded shot videos and can continue.
- Duration errors: keep each Seedance shot duration within model limits; build longer films from multiple shots.

## Output style

When reporting completion, include:

- session title
- shot readiness summary
- final video local path
- browser URL for the final video
- notable recovery steps, only if they matter for future iterations
