---
name: seereel-shortdrama
description: Use when a user asks SeeReel to plan, direct, storyboard, generate, continue, repair, or stitch AI video workflows, especially long videos, one-take shots, drone routes, first-frame/tailframe continuity, Seedance shots, reference images, or visible cloud sessions.
---

# SeeReel Director

SeeReel is a cloud-visible production board. The agent is the director: design the route, rhythm, references, continuity mode, generation order, retries, and stitch plan before pressing render. The web app is the takeover surface: every prompt, asset, storyboard, shot, tailframe, edge, render, stitch job, and final video must remain visible in the cloud session.

## Core Rules

- Use `seereelcli` or SeeReel APIs; do not use private local scripts as the production workflow.
- Upload local user素材 once, then generate characters, scenes, storyboards, shots, tailframes, stitch jobs, and final video through SeeReel cloud APIs.
- Do not use local ffmpeg, local recovered MP4 imports, or hidden scratch media for cloud-only workflows unless recovering from a terminal provider failure; if recovery is unavoidable, write the result back into visible SeeReel state.
- Seedance shots are max 15s. For any requested duration: `shotCount = Math.ceil(totalDurationSec / 15)`.
- Seedance tasks may exceed 15 minutes. Keep polling patiently; do not resubmit just because a task is slow.
- Only send public or signed `http(s)` URLs to Seedance. Local `/media/...` preview paths must be published to TOS first.

## Short One-Shot Frame Director

Treat "一镜到底", "one-shot", 30s, and 60s requests as a short one-shot illusion made from visible Seedance segments joined by deliberate first/last-frame continuity.

- 30s = 2 shots/segments; 60s = 4 shots/segments.
- 30min is an edge case: 30min = 120 shots/segments at 15s each. Do not center normal director behavior around this unless the user truly asks for a long-form piece.
- Each segment needs a local beat, an entry state, an exit state, and a continuity handoff to the next segment.
- Do not ask the model to make a true 30s/60s single generation when it exceeds the provider limit. Build a routed chain and stitch it.

Before generating, write these into the session:

1. **Route bible**: fixed geography, start/end points, altitude bands, turn direction, landmarks, forbidden drift, and what must not appear. For drone routes, preserve the path as motion intent; do not render the drawn route line unless the user asks.
2. **Rhythm map**: divide the full duration into 15s segments. Example for 60s: launch 0-15s, climb 15-30s, sweep/loop 30-45s, descent/resolve 45-60s.
3. **Segment sheet**: for every shot, store title, duration, camera motion, entry frame, mid-beat, exit frame, references, continuity mode, and retry note.
4. **Frame bridge plan**: decide how each shot's final frame becomes the next shot's first frame. For 30s/60s one-shot requests, this is the default directing work, not an optional repair step.
5. **Continuity bible**: repeat the same visual identity in every prompt: camera type, world, time of day, skyline/weather, lens feel, color grade, motion smoothness, and negative constraints.

## Frame Mode Decision Table

Use one continuity mode per shot. Do not stack mutually exclusive modes.

| Situation | Use | Patch / action |
| --- | --- | --- |
| Shot 1 must start from an exact uploaded image/composition 首帧 | first-frame anchor | `firstFrameAssetId=<asset>`; no normal reference images for that shot |
| Shot N must begin exactly where shot N-1 ended 尾帧接力 | strict tailframe -> first frame | `seereelcli node tailframe --id <prevShot> --publish-tos --canvas-node --json`, then `firstFrameAssetId=<tailframeAsset>` |
| Shot N should follow previous motion/framing but can adapt content | reference-video continuity | `referenceVideoFromShotId=<prevShot>` or `usePreviousShotClip=true`, `previousShotClipSec=2-4` |
| A long 15s segment needs four in-shot beats | storyboard reference | generate a 2x2 or 3x3 sub-storyboard and attach as `assetIds`; avoid `firstFrameAssetId` unless opening lock matters more |
| User provides a route/reference image | input reference asset | upload as session asset, mention it in route bible, attach to storyboard planning; do not draw it in final unless requested |
| Need a precise end pose for a later segment | last-frame planning | set or preserve `lastFrameAssetId` when available, otherwise extract tailframe after render and connect it visibly |

Default for short one-shot illusion:

- Shot 1: use uploaded/reference image as planning reference; use `firstFrameAssetId` only if the opening frame must match exactly.
- Shot 2+: prefer strict tailframe -> `firstFrameAssetId` when seamless visual continuity matters most. This is the default for 30s/60s one-shot videos.
- If the UI/API exposes `lastFrameAssetId`, preserve the planned exit pose/composition there; otherwise extract the strict tailframe after render and connect it visibly.
- Use `referenceVideoFromShotId` / `usePreviousShotClip` when motion continuity matters more than exact pixel continuity.
- Generate serially. Wait for shot N, create/publish tailframe if needed, patch shot N+1, then generate N+1.

## Prompt Pattern

Every Seedance prompt should carry:

1. Continuity bible.
2. Segment number and role in the rhythm map.
3. Entry frame: what the viewer sees at 0s.
4. Motion beats: `0-4s`, `4-9s`, `9-13s`, `13-15s`.
5. Exit frame: what must be true at the final frame for the next handoff.
6. Negative constraints: no subtitles, no text overlays, no route line unless requested, no landmark jumps, no teleporting, no style drift.

For drone FPV routes, write like a flight plan: altitude, speed, banking direction, landmark pass order, distance to buildings, water/skyline relation, and exit bearing.

## SeeReel Cloud Workflow

Use this order for full automation:

1. Create/select one session.
2. Upload local user references as cloud assets.
3. Save route bible, rhythm map, and segment sheet in session/shot prompts.
4. Generate server-side storyboard/sub-storyboard assets for the segments.
5. Publish any local references/tailframes to TOS before Seedance.
6. Generate shots serially according to the frame-mode plan.
7. Poll patiently; Seedance can run longer than 15 minutes.
8. After each ready shot, inspect state, extract tailframe when needed, and patch the next shot.
9. Stitch only when required shots are `ready`.
10. Download only the final cloud artifact to the user computer.
11. Return the final path plus a fresh `handoffUrl`, not a raw CLI-only `webUrl`.

## Failure Handling

- Slow task: keep polling same `cgt-*` task; do not duplicate submissions.
- Expired reference URL: republish to TOS or remove from `assetIds`, then retry.
- Bad continuity: regenerate the earliest broken segment before continuing downstream.
- Stitch failure: retry `/stitch` before regenerating shots.
- User edits the board: treat the UI state as source of truth and refresh status before continuing.

## Output Checklist

When reporting back, include session id/title, handoff URL, shot count, ready/failed summary, final local path, and what intermediate nodes exist in the cloud session.
