# Generation Workflow

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-04

## Purpose

Define how SeeReel creates, edits, reviews, retries, and stitches generated media while keeping user-visible canvas state as the source of truth.

## Scope

- Script, character, scene, storyboard, image, video, review, retry, and stitch workflows.
- Prompt editing before and during generation.
- Seedance, Seedream, Seed text generation, VLM review, and final stitching state.
- API and UI behavior for generation nodes.
- CLI-created sessions and browser handoff behavior for human takeover.
- CLI cloud-only production runs where user-provided local素材 may be uploaded once, while generated intermediates are created and stored by SeeReel server tasks.
- Agent director workflows for short one-shot-illusion videos, including route/rhythm planning and first-frame/tailframe/reference-video continuity decisions.

## Non-Goals

- This spec does not define provider pricing.
- This spec does not require paid generation for ordinary local smoke tests.
- This spec does not define every provider-specific parameter.

## User Stories

- As a creator, I can edit prompts while shaping a workflow and see the saved value in the node.
- As a creator, I understand whether the current running provider request used the old prompt or the new prompt.
- As an operator, I can audit which prompt, references, assets, and review settings produced each render.
- As a human reviewer, I can claim a CLI-created workflow in my browser and continue editing it without sharing the CLI cookie identity.

## Product Rules

- Canvas state and SeeReel APIs are the source of truth for prompts, references, renders, review settings, stitch order, and final video URLs.
- Manual filesystem recovery is allowed only as a recovery step, and recovered media must be written back into visible app state.
- In CLI cloud-only mode, local files are allowed only as user input references. Characters, scenes, storyboards, shot videos, stitch outputs, and final videos must be produced through SeeReel APIs/server jobs, persisted in canvas state, and not fabricated from local scratch media.
- The project globally does not generate subtitles as part of video output.
- Seedance reference inputs must be public or signed `http(s)` URLs, not local `/media/...` preview paths.
- Tail-frame assets used as a next-shot first-frame anchor must be extracted from the strict final decoded frame of the source video, not from an approximate near-end timestamp.
- If a provider request has not been submitted, prompt edits must affect the next submission.
- If a provider request has already been submitted, UI must make clear whether the current render uses the old prompt and whether retry/regeneration will use the new prompt.
- Review controls must be interactive and must not be hard-coded differently between local and production.
- CLI and browser identities are isolated by `seereel_user_id` cookies. A raw CLI `webUrl` must not be described as browser-visible handoff; agents should return a one-time `handoffUrl` when a human needs to claim and edit the workflow.
- Handoff links must be same-origin API links under `/api/handoff/:token`, unguessable, time-limited, one-time use, and transfer the session owner to the current browser identity before redirecting to the session workspace.
- Handoff must not make sessions public or weaken owner checks; users without the original owner cookie or an unclaimed handoff token must keep receiving not-found responses for isolated sessions.
- A CLI cloud-only run that renders video must be able to upload the user reference, generate server-side storyboard assets, render shots, stitch the final video, then download only the final cloud artifact to the user computer.
- 30s/60s one-shot requests must be planned as visible Seedance-sized shot chains with an explicit frame bridge plan. The director skill must teach agents to compute shot count with `Math.ceil(totalDurationSec / 15)`, design a route bible and rhythm map, choose first-frame/tailframe/reference-video modes intentionally, and keep all intermediate nodes visible in the cloud session. 30min requests are treated as an edge case, not the default workflow center.

## Acceptance Criteria

- [ ] A video node can persist prompt edits while queued or rendering.
- [ ] The UI clearly distinguishes saved prompt from submitted prompt when they differ.
- [ ] Retry and regeneration use the current saved prompt unless the user explicitly selects an older render.
- [ ] Review toggle behavior is the same in local and production builds.
- [ ] Stitching only uses ready shots and records the connected order in visible state.
- [ ] Tail-frame extraction returns the source video's strict final decoded frame and preserves the decoded frame dimensions.
- [ ] No generated video workflow emits subtitle files or burns subtitles by default.
- [ ] A session created under one cookie identity is hidden from a second cookie identity before handoff, visible to the second identity after claiming `handoffUrl`, and no longer visible to the original CLI identity after claim.
- [ ] CLI `workflow --json` includes `webUrlVisibleInBrowser: false` and a same-origin `/api/handoff/:token` `handoffUrl`; `seereelcli handoff --session latest --json` can generate a new handoff link for an existing CLI-owned session.
- [ ] Reusing a claimed handoff token returns not-found and does not transfer ownership again.
- [ ] `seereelcli workflow --cloud-only --reference-image <path-or-url> --render --stitch --output <file>` uploads the reference as an input asset, performs storyboard/render/stitch through server APIs, returns a handoff URL, and downloads the final cloud artifact without creating local intermediate media.
- [ ] `npm run smoke:seereel-director-skill` passes and proves the SeeReel director skill covers short one-shot illusion planning, 30s-to-2-shot and 60s-to-4-shot decomposition, frame bridge planning, route bible/rhythm map design, first-frame/tailframe/reference-video continuity, long Seedance waits, and cloud-session visibility.

## Verification

- [ ] `npm run verify:offline`
- [ ] Run `npm run smoke:vlm-review-toggle` when review behavior changes.
- [ ] Run `npm run smoke:seereel-handoff` when cookie ownership or CLI handoff behavior changes.
- [ ] Run `npm run smoke:seereel-cli-cloud-only` when CLI cloud-only workflow behavior changes.
- [ ] Run `npm run smoke:seereel-director-skill` when agent director, one-shot, first-frame, tailframe, or route-planning skill behavior changes.
- [ ] Run `npm run smoke:tailframe-strict` when tail-frame extraction or first-frame chaining changes.
- [ ] Use the local app to edit a rendering or queued video node prompt and confirm persisted state.
- [ ] For provider-facing changes, verify submitted request payloads with safe test inputs before release.

## Change Policy

Update this spec before changing node status semantics, prompt persistence, provider submission, review toggles, retry policy, stitching behavior, or CLI/browser session handoff behavior.
