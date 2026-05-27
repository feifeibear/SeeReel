# reelyai-agent API Reference

## Base URL

Use:

```bash
BASE_URL="${REELYAI_AGENT_BASE_URL:-${CINEMA_AGENT_BASE_URL:-http://localhost:5173}}"
```

## Core Endpoints

- `GET /api/state`: returns `{ assets, sessions, shots }`.
- `POST /api/sessions`: creates a session and initial shots.
- `PATCH /api/sessions/:sessionId`: updates session fields such as `title`.
- `POST /api/sessions/:sessionId/promote`: moves a session to the latest position.
- `POST /api/sessions/:sessionId/script/generate`: generates and saves the session story plan.
- `PATCH /api/sessions/:sessionId/script`: saves an edited story plan.
- `POST /api/sessions/:sessionId/storyboard`: generates shot scripts/prompts.
- `POST /api/assets`: creates an asset.
- `PATCH /api/assets/:assetId`: updates an asset.
- `POST /api/assets/:assetId/generate`: generates an asset reference image.
- `PATCH /api/shots/:shotId`: updates shot fields.
- `POST /api/shots/:shotId/generate`: starts shot video generation.
- `POST /api/shots/:shotId/poll`: checks async generation status.
- `POST /api/shots/:shotId/cancel`: cancels generation when supported.
- `POST /api/sessions/:sessionId/stitch`: triggers stitch. Returns immediately (no awaiting). Body fields: `stitchStatus` is `ready` (cache hit), `running` (background worker started or already running, dedup'd by input signature), or `error` (previous attempt failed; calling /stitch again retries). When `running`, poll `/stitch/poll` to observe `stitchProgress` and the final `finalVideoUrl`. A dropped client connection NEVER aborts the underlying ffmpeg work.
- `POST /api/sessions/:sessionId/stitch/poll`: returns the latest session snapshot. Read `stitchStatus`, `stitchProgress`, `stitchError`, `finalVideoUrl`.
- `GET /api/shots/:shotId/download`: downloads a shot video.
- `GET /api/sessions/:sessionId/download`: downloads the final video.

## Session Payload

```json
{
  "title": "unamed session 1",
  "logline": "一个失眠的年轻导演在午夜便利店遇到未来的自己。",
  "style": "neo-noir, handheld realism, rain reflections",
  "targetDurationSec": 60,
  "shotCount": 4
}
```

If `title` is empty, the server assigns `unamed session N`.

## Story Payload

`Session.story` stores the editable script layer:

```json
{
  "premise": "一句话故事",
  "synopsis": "300-800字短片大纲",
  "theme": "主题",
  "tone": "风格/情绪",
  "characters": [
    {
      "name": "顾沉",
      "role": "主角",
      "arc": "从逃避到直面自己",
      "assetMention": "@男主角/顾沉"
    }
  ],
  "beats": [
    {
      "index": 1,
      "title": "雨夜进店",
      "purpose": "建立人物处境",
      "plot": "@男主角/顾沉 走进午夜便利店。",
      "emotion": "疲惫、警觉",
      "visual": "雨水、霓虹、便利店冷光",
      "assetMentions": ["@男主角/顾沉"],
      "durationSec": 15
    }
  ],
  "locked": false
}
```

Generate script:

```bash
curl -sS -X POST "$BASE_URL/api/sessions/$SESSION_ID/script/generate"
```

Save edited script:

```bash
curl -sS -X PATCH "$BASE_URL/api/sessions/$SESSION_ID/script" \
  -H 'Content-Type: application/json' \
  -d '{"story": { ... }}'
```

## Shot Fields

Important fields:

- `title`: shot title visible in the UI.
- `durationSec`: 1-15 seconds for Seedance.
- `rawPrompt`: user's core prompt, may contain `@资产名`.
- `prompt`: expanded final prompt used for video generation.
- `assetIds`: explicit asset references.
- `usePreviousShotClip`: enables reference-video continuity from the previous shot.
- `previousShotClipSec`: tail length for reference-video continuity.
- `firstFrameAssetId`: optional asset id used as Seedance first-frame for this shot. Mutually exclusive with `usePreviousShotClip` and with all `reference_image / reference_video / reference_audio` payload entries (server drops them automatically when this is set). Primarily intended for shot 1. The referenced asset must have a public http(s) `mediaUrl`.
- `status`: `draft`, `scripted`, `generating`, `ready`, `error`, or `cancelled`.
- `videoUrl`: selected result video.
- `renders`: generation history (each render also captures its `firstFrameAssetId` snapshot so switching back to a historical render restores the setting).

Continuity patch:

```bash
curl -sS -X PATCH "$BASE_URL/api/shots/$SHOT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"usePreviousShotClip":true,"previousShotClipSec":2}'
```

## Asset Payload

```json
{
  "name": "男主角/顾沉",
  "type": "character",
  "mediaKind": "image",
  "description": "三十岁左右，黑色风衣，疲惫但敏锐。",
  "prompt": "三十岁左右的年轻导演，黑色风衣，疲惫但敏锐，电影感人物参考图。",
  "tags": ["男主角", "顾沉"]
}
```

Generate image with Seedream 4:

```bash
curl -sS -X POST "$BASE_URL/api/assets/$ASSET_ID/generate" \
  -H 'Content-Type: application/json' \
  -d '{"model":"seedream-4"}'
```

## Example Flow

Create session:

```bash
curl -sS -X POST "$BASE_URL/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"title":"","logline":"一个失眠导演在便利店遇到未来的自己。","style":"cinematic, rain, grounded sci-fi","targetDurationSec":60,"shotCount":4}'
```

Storyboard:

```bash
curl -sS -X POST "$BASE_URL/api/sessions/$SESSION_ID/storyboard"
```

Generate and poll one shot:

```bash
curl -sS -X POST "$BASE_URL/api/shots/$SHOT_ID/generate"
curl -sS -X POST "$BASE_URL/api/shots/$SHOT_ID/poll"
```

Stitch:

```bash
curl -sS -X POST "$BASE_URL/api/sessions/$SESSION_ID/stitch"
```

## First-frame mode (shot 1)

Use when the user wants the opening shot to literally start FROM a specific image (movie poster, meme frame, product hero shot, storyboard panel, etc.). Pre-check that the chosen asset has a public http(s) `mediaUrl`; if it only has `/media/...`, generate it via Seedream first:

```bash
# 1. Ensure the asset has a remote URL (skip if it already has one).
curl -sS -X POST "$BASE_URL/api/assets/$ASSET_ID/generate" \
  -H 'Content-Type: application/json' \
  -d '{"model":"seedream-4"}'

# 2. Tag shot 1 with the first-frame asset (clears usePreviousShotClip automatically on generate).
curl -sS -X PATCH "$BASE_URL/api/shots/$SHOT1_ID" \
  -H 'Content-Type: application/json' \
  -d '{"firstFrameAssetId":"'$ASSET_ID'","usePreviousShotClip":false}'

# 3. Generate as usual.
curl -sS -X POST "$BASE_URL/api/shots/$SHOT1_ID/generate"
curl -sS -X POST "$BASE_URL/api/shots/$SHOT1_ID/poll"
```

What the server actually does behind the scenes:

- Builds the Seedance payload with `{ type: "image_url", image_url: { url: <asset.mediaUrl> }, role: "first_frame" }` instead of `role: "reference_image"`.
- Drops every `reference_image / reference_video / reference_audio` entry from the same payload (BytePlus Seedance does not allow mixing first/last-frame mode with reference media).
- Forces `usePreviousShotClip = false` and clears `referenceClipUrl / referenceAudioUrl` for this submission.
- Snapshots `firstFrameAssetId` into the created render so switching back to that render in the UI restores the setting.

Clear first-frame mode (revert shot 1 to normal reference-image behavior):

```bash
curl -sS -X PATCH "$BASE_URL/api/shots/$SHOT1_ID" \
  -H 'Content-Type: application/json' \
  -d '{"firstFrameAssetId":null}'
```
