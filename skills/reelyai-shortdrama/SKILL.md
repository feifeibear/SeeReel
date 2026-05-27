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

## Standard flow

1. Ensure the app is running.
   - Development: `npm run dev`
   - Production preview: `NODE_ENV=production PORT=5174 npm run start`
   - On this host, use Node 22 in `PATH` if build/dev has Rollup native module issues.
2. Create or select a session. A short drama is one session.
3. Work with the user in chat to shape the premise, characters, tone, shot count, and duration.
4. Save the story plan and shots through app APIs or existing scripts so the web app reflects the work.
5. Generate or import reference images.
   - Use Codex imagegen when available for high-quality storyboards or character/scene references.
   - For cinematic storyboard contact sheets, follow the companion `reelyai-storyboard-imagegen` skill.
   - Import images into shot sketches with `POST /api/shots/:shotId/sketches/import`.
   - Keep sketches shot-scoped unless the user explicitly wants a reusable global asset.
6. Publish local references before video generation.
   - Remote Seedance cannot consume local `/media/...` URLs.
   - Use `POST /api/sessions/:sessionId/storyboards/publish-tos` or the web button "故事板 TOS".
   - If using private TOS buckets, leave `TOS_PUBLIC_BASE_URL` empty so ReelyAI stores pre-signed URLs.
7. Generate shots serially unless the user explicitly asks for parallel generation.
   - For continuity, let shot N+1 wait until shot N is ready.
   - Preserve "参考上一个分镜" semantics: use the full previous shot by default unless the user overrides duration; cap to the previous shot duration.
8. Stitch after every required shot is `ready`.
   - Use `POST /api/sessions/:sessionId/stitch`.
   - If stitching fails while downloading remote video, retry stitch before regenerating shots.
9. Return the local final video path and browser URL.

## Human takeover rules

- If the user edits prompt, duration, assets, or first-frame settings in the web app, treat that as source of truth.
- Do not overwrite manual edits unless the user asks for regeneration or a specific replacement.
- Use the UI as a review surface: after large changes, tell the user what they can inspect in the browser.

## Reference image rules

- Only send remote `http(s)` media URLs to Seedance.
- Treat expired TOS/Ark signed URLs as broken references. If a referenced asset returns `403` or times out, republish it or remove it from `assetIds` and keep the description in text.
- Codex imagegen storyboards should usually be compressed before ToS publish when Seedance fetches time out.
- Keep `first_frame` mode separate from generic `reference_image` mode. Do not mix first-frame/last-frame payloads with generic reference media in the same request.

## Useful API endpoints

- `GET /api/state`
- `POST /api/sessions`
- `PATCH /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/script/generate`
- `PATCH /api/sessions/:sessionId/script`
- `POST /api/sessions/:sessionId/storyboard`
- `POST /api/sessions/:sessionId/storyboards/publish-tos`
- `PATCH /api/shots/:shotId`
- `POST /api/shots/:shotId/sketches/import`
- `POST /api/shots/:shotId/generate`
- `POST /api/shots/:shotId/poll`
- `POST /api/sessions/:sessionId/stitch`
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
